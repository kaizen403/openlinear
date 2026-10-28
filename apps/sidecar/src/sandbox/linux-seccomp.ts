/**
 * Classic-BPF seccomp filter for the Linux sandbox, assembled here so no
 * native helper or libseccomp is needed. bubblewrap loads it with
 * `--seccomp <fd>` immediately before exec'ing the sandboxed command.
 *
 * Denied (EPERM) regardless of policy:
 * - cross-process memory/introspection: ptrace, process_vm_readv/writev
 * - io_uring_* (its opcodes perform I/O that a syscall filter never sees)
 * - namespace/mount manipulation: unshare, setns, mount, umount2, pivot_root,
 *   chroot, the new mount API, and clone() with any CLONE_NEW* flag; clone3
 *   returns ENOSYS so libc and language runtimes fall back to clone()
 * - kernel attack surface: bpf, perf_event_open, userfaultfd, keyctl family,
 *   module loading, kexec, open_by_handle_at, acct, swap, reboot, syslog
 * - (x86_64) the x32 ABI; any non-native architecture kills the process so
 *   compat syscall numbering cannot be used to bypass the table.
 */

export type SeccompArch = 'x64' | 'arm64';

const AUDIT_ARCH: Record<SeccompArch, number> = {
  x64: 0xc000003e,
  arm64: 0xc00000b7,
};

type SyscallTable = Record<string, number>;

const DENIED_X64: SyscallTable = {
  ptrace: 101,
  syslog: 103,
  pivot_root: 155,
  chroot: 161,
  acct: 163,
  mount: 165,
  umount2: 166,
  swapon: 167,
  swapoff: 168,
  reboot: 169,
  init_module: 175,
  delete_module: 176,
  kexec_load: 246,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  unshare: 272,
  perf_event_open: 298,
  name_to_handle_at: 303,
  open_by_handle_at: 304,
  setns: 308,
  process_vm_readv: 310,
  process_vm_writev: 311,
  finit_module: 313,
  kexec_file_load: 320,
  bpf: 321,
  userfaultfd: 323,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  mount_setattr: 442,
};

const DENIED_ARM64: SyscallTable = {
  umount2: 39,
  mount: 40,
  pivot_root: 41,
  chroot: 51,
  acct: 89,
  unshare: 97,
  kexec_load: 104,
  init_module: 105,
  delete_module: 106,
  syslog: 116,
  ptrace: 117,
  reboot: 142,
  add_key: 217,
  request_key: 218,
  keyctl: 219,
  swapon: 224,
  swapoff: 225,
  perf_event_open: 241,
  name_to_handle_at: 264,
  open_by_handle_at: 265,
  setns: 268,
  process_vm_readv: 270,
  process_vm_writev: 271,
  finit_module: 273,
  bpf: 280,
  userfaultfd: 282,
  kexec_file_load: 294,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  mount_setattr: 442,
};

const CLONE_NR: Record<SeccompArch, number> = { x64: 56, arm64: 220 };
const CLONE3_NR = 435;

/** CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET. */
export const CLONE_NAMESPACE_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const ENOSYS = 38;

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

interface Insn {
  code: number;
  k: number;
  /** Symbolic jump targets (labels) for conditional jumps. */
  jt?: string;
  jf?: string;
  label?: string;
}

export function deniedSyscalls(arch: SeccompArch): SyscallTable {
  return arch === 'x64' ? DENIED_X64 : DENIED_ARM64;
}

/** Assembles the filter for `arch` into the raw `struct sock_filter[]` bytes. */
export function buildSeccompFilter(arch: SeccompArch): Buffer {
  const program: Insn[] = [];
  const next = 'next';
  program.push({ code: BPF_LD_W_ABS, k: OFFSET_ARCH });
  program.push({ code: BPF_JMP_JEQ_K, k: AUDIT_ARCH[arch], jt: next, jf: 'kill' });
  program.push({ code: BPF_LD_W_ABS, k: OFFSET_NR });
  if (arch === 'x64') {
    // x32 ABI syscalls carry bit 30; never let them through.
    program.push({ code: BPF_JMP_JGE_K, k: 0x40000000, jt: 'eperm', jf: next });
  }
  for (const nr of Object.values(deniedSyscalls(arch))) {
    program.push({ code: BPF_JMP_JEQ_K, k: nr, jt: 'eperm', jf: next });
  }
  program.push({ code: BPF_JMP_JEQ_K, k: CLONE3_NR, jt: 'enosys', jf: next });
  program.push({ code: BPF_JMP_JEQ_K, k: CLONE_NR[arch], jt: 'clone', jf: next });
  program.push({ code: BPF_RET_K, k: SECCOMP_RET_ALLOW });
  program.push({ code: BPF_LD_W_ABS, k: OFFSET_ARG0_LOW, label: 'clone' });
  program.push({ code: BPF_JMP_JSET_K, k: CLONE_NAMESPACE_FLAGS, jt: 'eperm', jf: 'allow' });
  program.push({ code: BPF_RET_K, k: SECCOMP_RET_ALLOW, label: 'allow' });
  program.push({ code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EPERM, label: 'eperm' });
  program.push({ code: BPF_RET_K, k: SECCOMP_RET_ERRNO | ENOSYS, label: 'enosys' });
  program.push({ code: BPF_RET_K, k: SECCOMP_RET_KILL_PROCESS, label: 'kill' });

  const labels = new Map<string, number>();
  program.forEach((insn, index) => {
    if (insn.label) labels.set(insn.label, index);
  });
  const resolve = (from: number, target: string | undefined): number => {
    if (target === undefined || target === next) return 0;
    const to = labels.get(target);
    if (to === undefined) throw new Error(`[sandbox] seccomp label ${target} missing`);
    const offset = to - from - 1;
    if (offset < 0 || offset > 255) throw new Error('[sandbox] seccomp jump out of range');
    return offset;
  };
  const out = Buffer.alloc(program.length * 8);
  program.forEach((insn, index) => {
    out.writeUInt16LE(insn.code, index * 8);
    out.writeUInt8(resolve(index, insn.jt), index * 8 + 2);
    out.writeUInt8(resolve(index, insn.jf), index * 8 + 3);
    out.writeUInt32LE(insn.k >>> 0, index * 8 + 4);
  });
  return out;
}

/** Decision the filter makes, evaluated in JS for tests (mirrors the BPF). */
export function evaluateSeccompFilter(filter: Buffer, data: { arch: number; nr: number; arg0?: number }): number {
  const insns = [];
  for (let offset = 0; offset < filter.length; offset += 8) {
    insns.push({
      code: filter.readUInt16LE(offset),
      jt: filter.readUInt8(offset + 2),
      jf: filter.readUInt8(offset + 3),
      k: filter.readUInt32LE(offset + 4),
    });
  }
  let accumulator = 0;
  let pc = 0;
  for (let steps = 0; steps < 4096; steps += 1) {
    const insn = insns[pc];
    if (!insn) throw new Error('fell off the program');
    switch (insn.code) {
      case BPF_LD_W_ABS:
        accumulator = insn.k === OFFSET_ARCH ? data.arch : insn.k === OFFSET_NR ? data.nr : insn.k === OFFSET_ARG0_LOW ? (data.arg0 ?? 0) : 0;
        pc += 1;
        break;
      case BPF_JMP_JEQ_K:
        pc += 1 + ((accumulator >>> 0) === insn.k ? insn.jt : insn.jf);
        break;
      case BPF_JMP_JGE_K:
        pc += 1 + ((accumulator >>> 0) >= insn.k ? insn.jt : insn.jf);
        break;
      case BPF_JMP_JSET_K:
        pc += 1 + (((accumulator & insn.k) >>> 0) !== 0 ? insn.jt : insn.jf);
        break;
      case BPF_RET_K:
        return insn.k >>> 0;
      default:
        throw new Error(`unknown opcode ${insn.code}`);
    }
  }
  throw new Error('program did not terminate');
}

export const SECCOMP_RESULTS = {
  allow: SECCOMP_RET_ALLOW,
  eperm: SECCOMP_RET_ERRNO | EPERM,
  enosys: SECCOMP_RET_ERRNO | ENOSYS,
  kill: SECCOMP_RET_KILL_PROCESS,
} as const;

export const AUDIT_ARCHES = AUDIT_ARCH;

export function seccompArchFor(arch: string): SeccompArch | null {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return null;
}
