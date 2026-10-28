import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sidecarAppDataDir } from './app-data';
import { RunJournal } from '../journal/sqlite';
import { modelsDevCachePath } from '../catalogue/models-dev';

describe('sidecarAppDataDir', () => {
  it('follows XDG on Linux: $XDG_DATA_HOME/openlinear, default ~/.local/share/openlinear', () => {
    expect(sidecarAppDataDir({ HOME: '/home/ada' }, 'linux')).toBe('/home/ada/.local/share/openlinear');
    expect(sidecarAppDataDir({ HOME: '/home/ada', XDG_DATA_HOME: '/data/ada' }, 'linux')).toBe('/data/ada/openlinear');
    // Never the macOS location on Linux (the pre-fix journal/catalogue default).
    expect(sidecarAppDataDir({ HOME: '/home/ada' }, 'linux')).not.toContain('Library');
  });

  it('ignores an empty or relative XDG_DATA_HOME, as the XDG spec requires', () => {
    expect(sidecarAppDataDir({ HOME: '/home/ada', XDG_DATA_HOME: '' }, 'linux')).toBe('/home/ada/.local/share/openlinear');
    expect(sidecarAppDataDir({ HOME: '/home/ada', XDG_DATA_HOME: 'rel/data' }, 'linux')).toBe('/home/ada/.local/share/openlinear');
  });

  it('uses the XDG rule on other Unix platforms', () => {
    expect(sidecarAppDataDir({ HOME: '/home/ada' }, 'freebsd')).toBe('/home/ada/.local/share/openlinear');
  });

  it('keeps ~/Library/Application Support/OpenLinear on macOS', () => {
    expect(sidecarAppDataDir({ HOME: '/Users/ada', XDG_DATA_HOME: '/ignored' }, 'darwin')).toBe(
      '/Users/ada/Library/Application Support/OpenLinear',
    );
  });

  it('uses %LOCALAPPDATA%\\OpenLinear on Windows', () => {
    expect(sidecarAppDataDir({ LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'win32')).toBe(
      'C:\\Users\\ada\\AppData\\Local\\OpenLinear',
    );
    expect(sidecarAppDataDir({ LOCALAPPDATA: 'relative' }, 'win32')).toMatch(/AppData\\Local\\OpenLinear$/);
  });

  it('honours a non-empty OPENLINEAR_APP_DATA on every platform, as an absolute path', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(sidecarAppDataDir({ HOME: '/home/ada', OPENLINEAR_APP_DATA: '/srv/ol' }, platform)).toBe(resolve('/srv/ol'));
    }
    expect(sidecarAppDataDir({ HOME: '/home/ada', OPENLINEAR_APP_DATA: 'rel' }, 'linux')).toBe(resolve('rel'));
    // An empty value means unset (it used to produce a cwd-relative journal path).
    expect(sidecarAppDataDir({ HOME: '/home/ada', OPENLINEAR_APP_DATA: '' }, 'linux')).toBe('/home/ada/.local/share/openlinear');
  });

  it('falls back to the OS home directory when HOME is unset', () => {
    expect(sidecarAppDataDir({}, 'linux')).toBe(`${homedir()}/.local/share/openlinear`);
  });
});

describe('sidecar data files use the shared directory', () => {
  const linux = { HOME: '/home/ada', XDG_DATA_HOME: '/data/ada' };

  it('run journal', () => {
    expect(RunJournal.defaultPath(linux, 'linux')).toBe('/data/ada/openlinear/journal/runs.sqlite');
    expect(RunJournal.defaultPath({ HOME: '/Users/ada' }, 'darwin')).toBe(
      '/Users/ada/Library/Application Support/OpenLinear/journal/runs.sqlite',
    );
  });

  it('models.dev catalogue cache', () => {
    expect(modelsDevCachePath(linux, 'linux')).toBe('/data/ada/openlinear/cache/models.dev.json');
  });
});
