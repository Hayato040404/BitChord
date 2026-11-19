import { describe, expect, it } from 'vitest';
import type { PortableSession } from '@bitchord/shared/bridge';
import { cookieHeaderFor, parseSession, SessionFileError } from './session';

// The session file is the phone's only credential, so its reader is strict:
// a file that half-fits would be stored and then fail mid-request.

const cookie = (name: string, value: string, extra: Partial<PortableSession['youtube']['cookies'][number]> = {}) => ({
  name,
  value,
  domain: '.youtube.com',
  path: '/',
  secure: true,
  ...extra,
});

function file(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'bitchord-session',
    version: 1,
    exportedAt: 1_700_000_000_000,
    youtube: {
      cookies: [cookie('SAPISID', 'secret'), cookie('SID', 'sid')],
      sapisid: 'secret',
      authUser: '0',
      account: { name: 'Test', handle: '@test', avatarUrl: null, authUser: '0', channelId: null },
      ...overrides,
    },
  });
}

describe('parseSession', () => {
  it('reads a well-formed file', () => {
    const session = parseSession(file());
    expect(session.format).toBe('bitchord-session');
    expect(session.version).toBe(1);
    expect(session.youtube.sapisid).toBe('secret');
    expect(session.youtube.cookies).toHaveLength(2);
    expect(session.youtube.account?.name).toBe('Test');
  });

  it('fills a missing export time and account', () => {
    const session = parseSession(file({ account: undefined }));
    expect(session.youtube.account).toBeNull();
    expect(session.exportedAt).toBeGreaterThan(0);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseSession('not json')).toThrow(SessionFileError);
  });

  it('refuses another format or a newer version', () => {
    expect(() => parseSession(JSON.stringify({ format: 'other', version: 1, youtube: {} }))).toThrow(/session file/);
    expect(() =>
      parseSession(JSON.stringify({ format: 'bitchord-session', version: 2, youtube: { sapisid: 'x', cookies: [], authUser: '0' } })),
    ).toThrow(/newer version/);
  });

  it('refuses a file with no signing cookie', () => {
    expect(() => parseSession(file({ sapisid: '' }))).toThrow(/SAPISID/);
    expect(() => parseSession(file({ sapisid: undefined }))).toThrow(/SAPISID/);
  });

  it('refuses malformed cookies', () => {
    expect(() => parseSession(file({ cookies: [{ name: 'SAPISID' }] }))).toThrow(/cookies are malformed/);
    expect(() => parseSession(file({ cookies: 'nope' }))).toThrow(/cookies are malformed/);
  });

  it('refuses a signature that matches none of the cookies', () => {
    expect(() => parseSession(file({ sapisid: 'different' }))).toThrow(/doesn’t match/);
  });
});

describe('cookieHeaderFor', () => {
  const session: PortableSession = parseSession(
    JSON.stringify({
      format: 'bitchord-session',
      version: 1,
      exportedAt: 1,
      youtube: {
        cookies: [
          cookie('SAPISID', 'a'),
          cookie('PREF', 'b', { domain: '.youtube.com' }),
          cookie('OTHER', 'c', { domain: '.google.com' }),
          cookie('EXPIRED', 'd', { expirationDate: 1 }),
          cookie('TOMORROW', 'e', { expirationDate: Date.now() + 86_400_000 }),
        ],
        sapisid: 'a',
        authUser: '0',
        account: null,
      },
    }),
  );

  it('matches the host and its parent domains, without the leading dot', () => {
    expect(cookieHeaderFor(session, 'https://music.youtube.com/')).toBe('SAPISID=a; PREF=b; TOMORROW=e');
    expect(cookieHeaderFor(session, 'https://www.youtube.com/')).toBe('SAPISID=a; PREF=b; TOMORROW=e');
  });

  it('drops cookies for other hosts and expired ones', () => {
    const header = cookieHeaderFor(session, 'https://music.youtube.com/');
    expect(header).not.toContain('OTHER');
    expect(header).not.toContain('EXPIRED');
  });

  it('does not match a lookalike domain', () => {
    expect(cookieHeaderFor(session, 'https://evilyoutube.com/')).toBe('');
  });
});
