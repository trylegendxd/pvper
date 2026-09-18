function getSessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (env.NODE_ENV === 'production' &&
      (!secret || secret.length < 32 || /^(dev_change_me|change_me)/i.test(secret))) {
    throw new Error('SESSION_SECRET must be a unique secret of at least 32 characters in production');
  }
  return secret || 'dev_change_me';
}

module.exports = { getSessionSecret };
