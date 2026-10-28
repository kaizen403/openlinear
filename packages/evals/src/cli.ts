import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectDrift, observeEnvironment } from './manifest/drift';
import { findFloatingRefs } from './manifest/resolve';
import { manifestDigest, parseManifest } from './manifest/schema';
import { buildReport, type EvalReport, renderMarkdown } from './report/report';
import { buildFundedRunners, planFundedRun } from './funded';
import { runEvaluation } from './harness';
import { prepareFeatureEnvironment } from './features/pipeline';
import { enabledFeatures } from './features/types';
import { replayEvaluation } from './replay';
import { ABLATION_NAMES, ABLATIONS, type AblationName, ablationDefinition, type AblationRunnerChoice, planAblation, runAblationSmoke } from './suites/ablations';
import { EVAL_SYSTEM_CONTRACT, runSmoke } from './smoke';
import { loadHoldout } from './tasks/holdout';
import { estimateBudget, renderBudget } from './suites/budget';
import { ingestHarborJob } from './suites/harbor';
import { sweProDryRun, SWEPRO_V2_PIN } from './suites/swe-bench-pro';
import { readImagesManifest, tb4DryRun, TB4_PIN } from './suites/terminal-bench';
import { hashFile } from './util/hash';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
/** pnpm runs package scripts in the package directory; resolve user paths against where they ran the command. */
const userPath = (p: string) => (isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p));

const USAGE = `openlinear eval harness (offline; no inference)

  smoke [--out DIR] [--repeats N] [--seed N] [--concurrency N] [--quiet]
      Full pipeline on 5 synthetic tasks with FAKE runners; writes report.md/report.json.
  validate-manifest FILE
      Schema check, floating references, local drift.
  report DIR
      Re-render DIR/report.md from DIR/report.json.
  dry-run tb4 [--images FILE] [--checkout DIR] [--repeats 5] [--concurrency 8] [--env docker] [--jobs-dir jobs] [--contingency 0.25] [--official]
  dry-run swe-pro [--subset hard51|full] [--hard51 FILE] [--checkout DIR] [--verify] [--repeats 5] [--concurrency 8] [--env docker] [--jobs-dir jobs] [--contingency 0.25]
      Print exactly what a funded run would execute (commands, pins, image counts, budget). Runs nothing.
  budget --tasks N --repeats N --config ID=MEAN_USD[:MINUTES] [--config …] [--contingency 0.25] [--cap USD] [--concurrency N]
      PRD §10 formula: tasks × repeats × configurations × mean cost + contingency.
  ingest-harbor --job DIR --manifest FILE --config ID --suite ID [--out DIR]
      Convert a Harbor job directory into trial records and a report.
  replay --manifest FILE --holdout DIR --recordings RUN_DIR [--out DIR]
      Re-run a finished run offline from its recorded trajectories (no inference); outcomes must match.
  run --manifest FILE --holdout DIR --out DIR --confirm-spend [--adapter-module PATH] [--allow-real]
      [--credentials-env NAME,NAME] [--api-url URL --sidecar-url URL --token-env NAME --project-id ID [--team-id ID] --origin PATH]
      [--sidecar-src DIR] [--knowledge-dir DIR]
      FUNDED run on the private holdout with real runners. Refuses without --confirm-spend or with an unfrozen manifest.
      Configurations with \`features\` (W21 ablations) load the sidecar's feature code from --sidecar-src (default apps/sidecar/src).
  ablation list
      The W21 ablations (W16b repository context, W19b project knowledge, W19a reviewer).
  ablation plan NAME [--holdout DIR] [--knowledge NAME] [--knowledge-dir DIR] [--repeats 5] [--seed N]
      [--runner codex|opencode|claude-code --model ID --provider NAME] [--holdout-revision SHA] [--write FILE]
      The funded manifest (real runners, validation, non-sealed tasks): trials, worst-case USD, blocking problems. Runs nothing.
  ablation smoke NAME|all [--out DIR] [--repeats 4] [--seed N] [--concurrency N] [--sidecar-src DIR] [--quiet]
      Both arms offline with FAKE runners and the real sidecar feature code; prints the paired report.
`;

async function smoke(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, repeats: { type: 'string' }, seed: { type: 'string' }, concurrency: { type: 'string' }, quiet: { type: 'boolean', default: false } },
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = values.out ? userPath(values.out) : join(tmpdir(), 'openlinear-eval', `smoke-${stamp}`);
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  const result = await runSmoke({
    outDir,
    repeats: values.repeats ? Number(values.repeats) : undefined,
    seed: values.seed ? Number(values.seed) : undefined,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    onProgress: values.quiet ? undefined : (line) => process.stdout.write(`${line}\n`),
  });
  const markdown = renderMarkdown(result.report);
  const primary = markdown.split('\n## ').find((section) => section.startsWith('Primary result'));
  const paired = markdown.split('\n## ').find((section) => section.startsWith('Paired comparisons'));
  process.stdout.write(`\n## ${primary ?? ''}\n## ${paired ?? ''}\n`);
  process.stdout.write(`Trials: ${result.records.length} (${result.report.infraReruns} infra rerun(s)); wall clock ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  process.stdout.write(`Report: ${result.reportMarkdownPath}\nJSON:   ${result.reportJsonPath}\n`);
  if (result.problems.length > 0) {
    process.stderr.write(`\nSMOKE FAILED (${result.problems.length} problem(s)):\n${result.problems.map((p) => `- ${p}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('Smoke self-checks: OK (fake runners — pipeline check, not a benchmark)\n');
  return 0;
}

async function validateManifest(args: string[]): Promise<number> {
  const file = args[0];
  if (!file) throw new Error('validate-manifest FILE');
  const manifest = parseManifest(JSON.parse(await readFile(userPath(file), 'utf8')));
  const floating = findFloatingRefs(manifest);
  const drift = detectDrift({ manifest, environment: await observeEnvironment() });
  process.stdout.write(`manifest ${manifest.id} (${manifest.purpose}/${manifest.track}) digest ${manifestDigest(manifest)}\n`);
  process.stdout.write(floating.length ? `floating references:\n${floating.map((f) => `- ${f.field}: ${f.value} (${f.reason})`).join('\n')}\n` : 'frozen: no floating references\n');
  process.stdout.write(drift.length ? `drift vs this host:\n${drift.map((d) => `- ${d.severity} ${d.field}: ${d.expected} → ${d.observed}`).join('\n')}\n` : 'no drift vs this host\n');
  return floating.length > 0 && manifest.purpose !== 'smoke' ? 2 : 0;
}

async function report(args: string[]): Promise<number> {
  const dir = args[0];
  if (!dir) throw new Error('report DIR');
  const parsed = JSON.parse(await readFile(join(userPath(dir), 'report.json'), 'utf8')) as EvalReport;
  await writeFile(join(userPath(dir), 'report.md'), renderMarkdown(parsed));
  process.stdout.write(`${join(userPath(dir), 'report.md')}\n`);
  return 0;
}

const common = {
  repeats: { type: 'string', default: '5' },
  concurrency: { type: 'string', default: '8' },
  env: { type: 'string', default: 'docker' },
  'jobs-dir': { type: 'string', default: 'jobs' },
  contingency: { type: 'string', default: '0.25' },
  checkout: { type: 'string' },
} as const;

async function dryRun(args: string[]): Promise<number> {
  const [suite, ...rest] = args;
  if (suite === 'tb4') {
    const { values } = parseArgs({ args: rest, options: { ...common, images: { type: 'string' }, official: { type: 'boolean', default: false } } });
    const imagesPath = values.images ? userPath(values.images) : join(FIXTURES, 'tb4', 'prebuilt-images.excerpt.json');
    const images = await readImagesManifest(imagesPath);
    const excerpt = !values.images;
    if (excerpt) process.stdout.write(`(no --images given: using the 3-task excerpt fixture; download ${TB4_PIN.prebuiltImages.url} (sha256 ${TB4_PIN.prebuiltImages.sha256.slice(0, 16)}…, ${TB4_PIN.prebuiltImages.bytes} B) for the full plan)\n\n`);
    else process.stdout.write(`images manifest sha256 ${images.sha256} ${images.matchesPin ? 'matches the v4.0.0 release asset' : 'DOES NOT MATCH the pinned release asset'}\n\n`);
    const plan = await tb4DryRun({
      imagesManifest: images.json,
      expectComplete: !excerpt,
      checkoutDir: values.checkout ? userPath(values.checkout) : undefined,
      repeats: Number(values.repeats),
      concurrency: Number(values.concurrency),
      environment: values.env,
      jobsDir: values['jobs-dir'],
      contingency: Number(values.contingency),
      official: values.official,
    });
    process.stdout.write(`${plan.text}\n`);
    return 0;
  }
  if (suite === 'swe-pro') {
    const { values } = parseArgs({ args: rest, options: { ...common, subset: { type: 'string', default: 'hard51' }, hard51: { type: 'string' }, verify: { type: 'boolean', default: false } } });
    const hard51Path = values.hard51 ? userPath(values.hard51) : values.checkout ? join(userPath(values.checkout), SWEPRO_V2_PIN.hard51.path) : join(FIXTURES, 'swe-pro', 'hard51_ids.txt');
    const sha = await hashFile(hard51Path);
    if (sha !== SWEPRO_V2_PIN.hard51.sha256) process.stdout.write(`warning: ${hard51Path} sha256 ${sha} ≠ pinned ${SWEPRO_V2_PIN.hard51.sha256}\n`);
    const ids = (await readFile(hard51Path, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean);
    const subset = values.subset === 'full' ? 'full' : 'hard51';
    const plan = await sweProDryRun({
      subset,
      hard51Ids: ids,
      checkoutDir: values.checkout ? userPath(values.checkout) : undefined,
      verifyCheckout: values.verify,
      repeats: Number(values.repeats),
      concurrency: Number(values.concurrency),
      environment: values.env,
      jobsDir: values['jobs-dir'],
      contingency: Number(values.contingency),
    });
    process.stdout.write(`${plan.text}\n`);
    return 0;
  }
  throw new Error('dry-run tb4|swe-pro');
}

async function budget(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { tasks: { type: 'string' }, repeats: { type: 'string', default: '5' }, config: { type: 'string', multiple: true }, contingency: { type: 'string', default: '0.25' }, cap: { type: 'string' }, concurrency: { type: 'string', default: '1' } },
  });
  if (!values.tasks || !values.config?.length) throw new Error('budget --tasks N --config ID=MEAN_USD[:MINUTES] …');
  const configurations = values.config.map((spec) => {
    const match = /^([^=]+)=([\d.]+)(?::([\d.]+))?$/.exec(spec);
    if (!match?.[1] || !match[2]) throw new Error(`bad --config ${spec}`);
    return { id: match[1], meanCostUsd: Number(match[2]), ...(match[3] ? { meanMinutes: Number(match[3]) } : {}), basis: 'command line' };
  });
  const estimate = estimateBudget({
    tasks: Number(values.tasks),
    repeats: Number(values.repeats),
    configurations,
    contingency: Number(values.contingency),
    concurrency: Number(values.concurrency),
    perTaskCapUsd: values.cap ? Number(values.cap) : null,
  });
  process.stdout.write(`${renderBudget(estimate)}\n`);
  return 0;
}

async function ingest(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { job: { type: 'string' }, manifest: { type: 'string' }, config: { type: 'string' }, suite: { type: 'string' }, out: { type: 'string' } } });
  if (!values.job || !values.manifest || !values.config || !values.suite) throw new Error('ingest-harbor --job DIR --manifest FILE --config ID --suite ID');
  const manifest = parseManifest(JSON.parse(await readFile(userPath(values.manifest), 'utf8')));
  const records = await ingestHarborJob({ jobDir: userPath(values.job), manifest, configurationId: values.config, suiteId: values.suite });
  const outDir = values.out ? userPath(values.out) : join(userPath(values.job), 'openlinear-eval');
  await mkdir(outDir, { recursive: true });
  const built = buildReport({ manifest, records, gates: [], drift: manifest.drift, wallClockMs: 0 });
  await writeFile(join(outDir, 'trials.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(built, null, 2)}\n`);
  await writeFile(join(outDir, 'report.md'), renderMarkdown(built));
  process.stdout.write(`${records.length} trial(s) → ${join(outDir, 'report.md')}\n`);
  return 0;
}

async function replay(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { manifest: { type: 'string' }, holdout: { type: 'string' }, recordings: { type: 'string' }, out: { type: 'string' }, quiet: { type: 'boolean', default: false } } });
  if (!values.manifest || !values.holdout || !values.recordings) throw new Error('replay --manifest FILE --holdout DIR --recordings RUN_DIR');
  const manifest = parseManifest(JSON.parse(await readFile(userPath(values.manifest), 'utf8')));
  const holdout = await loadHoldout(userPath(values.holdout));
  const outDir = values.out ? userPath(values.out) : join(tmpdir(), 'openlinear-eval', `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const result = await replayEvaluation({
    manifest,
    tasks: holdout.tasks,
    recordingsDir: userPath(values.recordings),
    outDir,
    systemContract: EVAL_SYSTEM_CONTRACT,
    onProgress: values.quiet ? undefined : (line) => process.stdout.write(`${line}\n`),
  });
  const original = new Map<string, string>();
  const trialsFile = join(userPath(values.recordings), 'trials.jsonl');
  if (existsSync(trialsFile)) {
    for (const line of (await readFile(trialsFile, 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as { trialId: string; outcome: string };
      original.set(record.trialId, record.outcome);
    }
  }
  const mismatches = result.records.filter((r) => original.has(r.trialId) && original.get(r.trialId) !== r.outcome);
  process.stdout.write(`${result.records.length} trial(s) replayed → ${result.reportMarkdownPath}\n`);
  if (mismatches.length > 0) {
    process.stderr.write(`${mismatches.length} outcome(s) differ from the original run:\n${mismatches.map((r) => `- ${r.trialId}: ${original.get(r.trialId)} → ${r.outcome} (${r.reason})`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(original.size > 0 ? 'All replayed outcomes match the original run.\n' : '(no trials.jsonl next to the recordings: nothing to compare)\n');
  return 0;
}

async function funded(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: 'string' },
      holdout: { type: 'string' },
      out: { type: 'string' },
      'confirm-spend': { type: 'boolean', default: false },
      'adapter-module': { type: 'string' },
      'allow-real': { type: 'boolean', default: false },
      'credentials-env': { type: 'string', default: '' },
      'api-url': { type: 'string' },
      'sidecar-url': { type: 'string' },
      'token-env': { type: 'string' },
      'project-id': { type: 'string' },
      'team-id': { type: 'string' },
      origin: { type: 'string' },
      'sidecar-src': { type: 'string' },
      'knowledge-dir': { type: 'string' },
    },
  });
  if (!values.manifest || !values.holdout || !values.out) throw new Error('run --manifest FILE --holdout DIR --out DIR --confirm-spend …');
  const manifest = parseManifest(JSON.parse(await readFile(userPath(values.manifest), 'utf8')));
  const plan = planFundedRun(manifest);
  process.stdout.write(`FUNDED RUN PLAN: ${plan.trials} trial(s); worst case ${plan.worstCaseUsd === null ? 'UNBOUNDED' : `$${plan.worstCaseUsd.toFixed(2)}`} (per-task cap × trials + headroom)\n`);
  for (const problem of plan.problems) process.stdout.write(`- ${problem}\n`);
  if (!values['confirm-spend']) {
    process.stderr.write('Refusing: real inference costs money. Re-run with --confirm-spend once the budget is approved (PRD §10 pilot).\n');
    return 3;
  }
  if (plan.problems.some((p) => p.startsWith('floating reference') || p.startsWith('smoke manifests') || p.startsWith('feature unsupported'))) {
    process.stderr.write('Refusing: the manifest is not a frozen, non-smoke configuration whose features its runners can apply.\n');
    return 2;
  }
  const holdout = await loadHoldout(userPath(values.holdout));
  // W21: features are applied with the sidecar's own code; knowledge fixtures are checked against their pinned sha256.
  const features = manifest.configurations.some((config) => enabledFeatures(config).length > 0)
    ? await prepareFeatureEnvironment({
        manifest,
        tasks: holdout.tasks,
        ...(values['sidecar-src'] ? { sidecarSrc: userPath(values['sidecar-src']) } : {}),
        ...(values['knowledge-dir'] ? { knowledgeDir: userPath(values['knowledge-dir']) } : {}),
      })
    : undefined;
  const api =
    values['api-url'] && values['sidecar-url'] && values['token-env'] && values['project-id'] && values.origin
      ? { apiUrl: values['api-url'], sidecarUrl: values['sidecar-url'], tokenEnv: values['token-env'], projectId: values['project-id'], teamId: values['team-id'], originPath: userPath(values.origin) }
      : undefined;
  const runners = await buildFundedRunners(manifest, {
    adapterModule: values['adapter-module'] ? userPath(values['adapter-module']) : undefined,
    allowRealNative: values['allow-real'],
    credentialEnv: values['credentials-env'].split(',').map((n) => n.trim()).filter(Boolean),
    api,
  });
  const result = await runEvaluation({ manifest, tasks: holdout.tasks, runners, outDir: userPath(values.out), systemContract: EVAL_SYSTEM_CONTRACT, features, onProgress: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`Report: ${result.reportMarkdownPath}\n`);
  return 0;
}

const RUNNER_IDS = ['opencode', 'claude-code', 'codex'] as const;

async function ablation(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list' || sub === undefined) {
    for (const name of ABLATION_NAMES) {
      const definition = ABLATIONS[name];
      process.stdout.write(`${name}\n  ${definition.title}\n  ${definition.prd}\n  arms: ${definition.baselineId} vs ${definition.treatmentId}\n`);
    }
    return 0;
  }
  if (sub === 'plan') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        holdout: { type: 'string' },
        knowledge: { type: 'string' },
        'knowledge-dir': { type: 'string' },
        repeats: { type: 'string', default: '5' },
        seed: { type: 'string' },
        runner: { type: 'string' },
        model: { type: 'string' },
        provider: { type: 'string' },
        'holdout-revision': { type: 'string' },
        write: { type: 'string' },
      },
    });
    const name = ablationDefinition(positionals[0] ?? '').name;
    let runner: AblationRunnerChoice | undefined;
    if (values.runner || values.model || values.provider) {
      const id = RUNNER_IDS.find((candidate) => candidate === values.runner);
      if (!id || !values.model || !values.provider) throw new Error(`--runner ${RUNNER_IDS.join('|')} --model ID --provider NAME go together`);
      runner = { id, model: values.model, provider: values.provider };
    }
    const planned = await planAblation({
      name,
      ...(values.holdout ? { holdoutDir: userPath(values.holdout) } : {}),
      ...(values['knowledge-dir'] ? { knowledgeDir: userPath(values['knowledge-dir']) } : {}),
      ...(values.knowledge ? { knowledge: values.knowledge } : {}),
      repeats: Number(values.repeats),
      ...(values.seed ? { seed: Number(values.seed) } : {}),
      ...(runner ? { runner } : {}),
      ...(values['holdout-revision'] ? { holdoutRevision: values['holdout-revision'] } : {}),
    });
    process.stdout.write(`${planned.text}\n`);
    // The sample holdout was written to a temp dir for the illustration only.
    if (planned.sample) await rm(join(planned.holdout.root, '..'), { recursive: true, force: true });
    if (values.write) {
      await writeFile(userPath(values.write), `${JSON.stringify(planned.manifest, null, 2)}\n`);
      process.stdout.write(`\nManifest written to ${userPath(values.write)} (digest ${manifestDigest(planned.manifest)})\n`);
    }
    return 0;
  }
  if (sub === 'smoke') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { out: { type: 'string' }, repeats: { type: 'string' }, seed: { type: 'string' }, concurrency: { type: 'string' }, 'sidecar-src': { type: 'string' }, quiet: { type: 'boolean', default: false } },
    });
    const which = positionals[0] ?? '';
    const names: AblationName[] = which === 'all' ? [...ABLATION_NAMES] : [ablationDefinition(which).name];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let failed = 0;
    for (const name of names) {
      const outDir = values.out ? join(userPath(values.out), names.length > 1 ? name : '') : join(tmpdir(), 'openlinear-eval', `ablation-${name}-${stamp}`);
      await mkdir(outDir, { recursive: true });
      const started = Date.now();
      const result = await runAblationSmoke({
        name,
        outDir,
        ...(values.repeats ? { repeats: Number(values.repeats) } : {}),
        ...(values.seed ? { seed: Number(values.seed) } : {}),
        ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
        ...(values['sidecar-src'] ? { sidecarSrc: userPath(values['sidecar-src']) } : {}),
        onProgress: values.quiet ? undefined : (line) => process.stdout.write(`${line}\n`),
      });
      const markdown = renderMarkdown(result.report);
      const sections = markdown.split('\n## ').filter((section) => section.startsWith('Primary result') || section.startsWith('Ablation'));
      process.stdout.write(`\n# ${ABLATIONS[name].title}\n\n## ${sections.join('\n## ')}\n`);
      process.stdout.write(`Trials: ${result.records.length} (${result.report.infraReruns} infra rerun(s)); wall clock ${((Date.now() - started) / 1000).toFixed(1)} s\nReport: ${result.reportMarkdownPath}\n`);
      if (result.problems.length > 0) {
        failed += 1;
        process.stderr.write(`ABLATION SMOKE FAILED (${result.problems.length} problem(s)):\n${result.problems.map((p) => `- ${p}`).join('\n')}\n`);
      } else {
        process.stdout.write('Ablation self-checks: OK (FAKE runners: proves the plumbing, not a benefit)\n');
      }
    }
    return failed > 0 ? 1 : 0;
  }
  throw new Error('ablation list|plan|smoke');
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'smoke':
      return smoke(rest);
    case 'validate-manifest':
      return validateManifest(rest);
    case 'report':
      return report(rest);
    case 'dry-run':
      return dryRun(rest);
    case 'budget':
      return budget(rest);
    case 'ingest-harbor':
      return ingest(rest);
    case 'replay':
      return replay(rest);
    case 'run':
      return funded(rest);
    case 'ablation':
      return ablation(rest);
    default:
      process.stdout.write(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 64;
  }
}

const invokedDirectly = process.argv[1] !== undefined && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
