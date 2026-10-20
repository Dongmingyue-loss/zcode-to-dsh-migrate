'use strict';

const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|password|passwd|credential)/i;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function createRedactor(initialSecrets = []) {
  const secrets = new Set();
  for (const value of initialSecrets) add(value);

  function add(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < 6) return;
    secrets.add(trimmed);
    // Authorization headers are also matched as a whole.
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (bearer) secrets.add(bearer[1].trim());
  }

  function addFromObject(value) {
    if (Array.isArray(value)) {
      for (const item of value) addFromObject(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && SECRET_KEY_PATTERN.test(key)) add(child);
      else addFromObject(child);
    }
  }

  function redactString(text) {
    if (typeof text !== 'string') return text;
    let output = text;
    for (const secret of secrets) {
      if (secret && output.includes(secret)) output = output.split(secret).join('[REDACTED]');
    }
    output = output.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
    output = output.replace(API_KEY_PATTERN, '[REDACTED]');
    return output;
  }

  function redact(value) {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      const output = {};
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && SECRET_KEY_PATTERN.test(key)) {
          output[key] = child ? '[REDACTED]' : '';
        } else {
          output[key] = redact(child);
        }
      }
      return output;
    }
    return value;
  }

  return { add, addFromObject, redact, redactString, secrets };
}

module.exports = {
  createRedactor,
  SECRET_KEY_PATTERN,
};
