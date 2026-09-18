import { describe, expect, it } from 'vitest';
import {
  detectAuthenticated,
  detectHumanVerification,
  detectLoginRequired,
  detectNoAppointments,
  detectSiteError,
  isAppointmentUrl,
  redactQuery,
} from '../src/bls/BlsPageDetector';
import { snapshotFromFixture, snapshotFromHtml } from './helpers/snapshot';

const APPOINTMENT_URL = 'https://nigeria.blsspainglobal.com/Global/blsappointment/MyAppointments';
const LOGIN_URL = 'https://nigeria.blsspainglobal.com/Global/account/login';

describe('CAPTCHA / human-verification detection', () => {
  it('detects a reCAPTCHA page', () => {
    const snapshot = snapshotFromFixture('captcha-page.html', APPOINTMENT_URL);
    expect(detectHumanVerification(snapshot).detected).toBe(true);
  });

  it('detects a verification iframe even without matching text', () => {
    const snapshot = snapshotFromHtml(
      '<html><body><h1>Please wait</h1><iframe src="https://challenges.cloudflare.com/turnstile/v0/x"></iframe></body></html>',
      APPOINTMENT_URL,
    );
    expect(detectHumanVerification(snapshot).detected).toBe(true);
  });

  it('detects a Cloudflare interstitial by wording', () => {
    const snapshot = snapshotFromHtml(
      '<html><body><h1>Checking your browser before accessing the site</h1><p>Ray ID: 9a1</p></body></html>',
      APPOINTMENT_URL,
    );
    expect(detectHumanVerification(snapshot).detected).toBe(true);
  });

  it('does not fire on an ordinary appointment page', () => {
    const snapshot = snapshotFromFixture('no-appointments.html', APPOINTMENT_URL);
    expect(detectHumanVerification(snapshot).detected).toBe(false);
  });
});

describe('login detection', () => {
  it('detects the BLS login form', () => {
    const snapshot = snapshotFromFixture('login-page.html', LOGIN_URL);
    const result = detectLoginRequired(snapshot);
    expect(result.detected).toBe(true);
    expect(detectAuthenticated(snapshot).detected).toBe(false);
  });

  it('detects a bounce to the login route by URL alone', () => {
    const snapshot = snapshotFromHtml(
      '<html><body><p>Redirecting…</p></body></html>',
      'https://nigeria.blsspainglobal.com/Global/Account/LogIn?ReturnUrl=%2FGlobal%2Fblsappointment%2FMyAppointments',
    );
    expect(detectLoginRequired(snapshot).detected).toBe(true);
  });

  it('flags an expired session distinctly', () => {
    const snapshot = snapshotFromFixture('session-expired.html', APPOINTMENT_URL);
    const result = detectLoginRequired(snapshot);
    expect(result.detected).toBe(true);
    expect(result.sessionExpired).toBe(true);
  });

  it('treats an authenticated appointment page as logged in', () => {
    const snapshot = snapshotFromFixture('no-appointments.html', APPOINTMENT_URL);
    expect(detectLoginRequired(snapshot).detected).toBe(false);
    expect(detectAuthenticated(snapshot).detected).toBe(true);
  });
});

describe('site error detection', () => {
  it('detects a maintenance page', () => {
    const snapshot = snapshotFromFixture('site-error.html', APPOINTMENT_URL);
    expect(detectSiteError(snapshot).detected).toBe(true);
  });

  it('detects a 5xx response', () => {
    const snapshot = snapshotFromHtml('<html><body>ok</body></html>', APPOINTMENT_URL, 503);
    expect(detectSiteError(snapshot).detected).toBe(true);
  });

  it('detects rate limiting', () => {
    const snapshot = snapshotFromHtml('<html><body>ok</body></html>', APPOINTMENT_URL, 429);
    expect(detectSiteError(snapshot).detected).toBe(true);
  });

  it('does not fire on a healthy page', () => {
    const snapshot = snapshotFromFixture('no-appointments.html', APPOINTMENT_URL);
    expect(detectSiteError(snapshot).detected).toBe(false);
  });
});

describe('no-appointment detection', () => {
  it('detects the explicit BLS wording', () => {
    const snapshot = snapshotFromFixture('no-appointments.html', APPOINTMENT_URL);
    expect(detectNoAppointments(snapshot).detected).toBe(true);
  });

  it('does NOT fire on a page that simply has nothing on it', () => {
    const snapshot = snapshotFromFixture('unexpected-page.html', APPOINTMENT_URL);
    expect(detectNoAppointments(snapshot).detected).toBe(false);
  });

  it('does not fire on an availability page', () => {
    const snapshot = snapshotFromFixture('appointment-available.html', APPOINTMENT_URL);
    expect(detectNoAppointments(snapshot).detected).toBe(false);
  });
});

describe('url helpers', () => {
  it('recognises appointment urls but not the login bounce', () => {
    expect(isAppointmentUrl(APPOINTMENT_URL)).toBe(true);
    expect(isAppointmentUrl(`${LOGIN_URL}?ReturnUrl=%2FGlobal%2Fblsappointment`)).toBe(false);
  });

  it('strips query strings so identifiers never reach the logs', () => {
    expect(redactQuery('https://example.test/path?token=secret')).toBe(
      'https://example.test/path?[redacted]',
    );
  });
});
