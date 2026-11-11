import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/core/privacy.js';

describe('Privacy Redaction Enhancements (privacy.ts)', () => {
  it.each([
    'Cookie: session=syntheticCookieValue; csrf=anotherCookieValue\r\nAccept: text/plain',
    'set-cookie: sid=syntheticCookieValue; Path=/; HttpOnly',
    '{"Cookie":"sid=syntheticCookieValue; csrf=anotherCookieValue","Accept":"text/plain"}',
    "curl -H 'Cookie: sid=syntheticCookieValue; csrf=anotherCookieValue'",
    'headers: {"Set-Cookie": ["sid=syntheticCookieValue; HttpOnly", "csrf=anotherCookieValue"]}',
  ])('redacts complete credential-bearing cookie headers: %s', (raw) => {
    const result = redactSecrets(raw);
    expect(result.hasSensitive).toBe(true);
    expect(result.text).not.toContain('syntheticCookieValue');
    expect(result.text).not.toContain('anotherCookieValue');
    expect(result.text).toContain('[REDACTED:COOKIE]');
  });

  it('should redact PEM private keys', () => {
    const raw = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----';
    const res = redactSecrets(raw);
    expect(res.hasSensitive).toBe(true);
    expect(res.detectedKinds).toContain('PEM_KEY');
    expect(res.text).toBe('[REDACTED:PEM_KEY]');
  });

  it('should redact JWT tokens', () => {
    const raw = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const res = redactSecrets(raw);
    expect(res.hasSensitive).toBe(true);
    expect(res.text).not.toContain('eyJhbGci');
  });

  it('should redact URL credentials with standard and cloud protocols', () => {
    const samples = [
      {
        url: 'postgres://postgres:admin12345@localhost:5432/mydb',
        expected: 'postgres://postgres:[REDACTED:CREDENTIAL]@localhost:5432/mydb',
      },
      {
        url: 'mongodb+srv://adminUser:SuperP@ssw0rd!123@cluster0.mongodb.net/prod',
        expected: 'mongodb+srv://adminUser:[REDACTED:CREDENTIAL]@cluster0.mongodb.net/prod',
      },
      {
        url: 'rediss://default:mypassword@redis.cache.amazonaws.com:6379',
        expected: 'rediss://default:[REDACTED:CREDENTIAL]@redis.cache.amazonaws.com:6379',
      },
    ];

    for (const item of samples) {
      const res = redactSecrets(`Connection string: ${item.url}`);
      expect(res.hasSensitive).toBe(true);
      expect(res.detectedKinds).toContain('URL_CREDENTIAL');
      expect(res.text).toContain(item.expected);
    }
  });

  it('should redact standalone API keys and tokens from major providers', () => {
    const tokens = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz012345678901234567890123',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijklmnop',
    ];

    for (const tok of tokens) {
      const res = redactSecrets(`Error returned with token ${tok} in header`);
      expect(res.hasSensitive, `Token ${tok} should be detected`).toBe(true);
      expect(res.detectedKinds).toContain('API_KEY');
      expect(res.text).not.toContain(tok);
      expect(res.text).toContain('[REDACTED:API_KEY]');
    }
  });

  it('should redact key-value secret assignments', () => {
    const raw = 'const password = "mySecretPassword123"; const api_key = "AIzaSyD-1234567890abcdefghijklmnopqrst";';
    const res = redactSecrets(raw);
    expect(res.hasSensitive).toBe(true);
    expect(res.detectedKinds).toContain('SECRET_KEY');
    expect(res.text).not.toContain('mySecretPassword123');
    expect(res.text).not.toContain('AIzaSyD-');
  });
});
