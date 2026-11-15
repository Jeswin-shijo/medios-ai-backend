// Fails startup on configuration that would leave the API insecure, instead of
// silently falling back to defaults.

// Shipped in earlier versions of .env.example; anyone could forge tokens with it.
const KNOWN_PUBLIC_SECRETS = new Set(['medios_clinical_jwt_secret_key_2026_xyz']);
const MIN_SECRET_LENGTH = 32;

export function validateEnv(config: Record<string, unknown>) {
  const errors: string[] = [];
  const secret = typeof config.JWT_SECRET === 'string' ? config.JWT_SECRET : '';

  if (!secret) {
    errors.push('JWT_SECRET is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  } else if (secret.length < MIN_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  } else if (KNOWN_PUBLIC_SECRETS.has(secret)) {
    errors.push('JWT_SECRET is a publicly known example value; generate a new one.');
  }

  // There is no fallback database: on a shared machine a guessed localhost one may belong to another project.
  if (!String(config.MONGODB_URI ?? '').trim()) {
    errors.push('MONGODB_URI is required: the address of the MongoDB database to use (mongodb:// or mongodb+srv://), in .env or the host\'s settings. The API does not fall back to a local database.');
  }

  const origins = String(config.CORS_ORIGIN ?? '');
  if (origins.split(',').some((o) => o.trim() === '*')) {
    errors.push('CORS_ORIGIN cannot be "*": the API uses credentialed requests. List the allowed origins, comma-separated.');
  }

  const sameSite = config.COOKIE_SAMESITE;
  if (sameSite !== undefined && !['lax', 'strict', 'none'].includes(String(sameSite))) {
    errors.push('COOKIE_SAMESITE must be lax, strict or none.');
  }
  if (sameSite === 'none' && config.COOKIE_SECURE === 'false') {
    errors.push('COOKIE_SAMESITE=none requires secure cookies (COOKIE_SECURE=true).');
  }

  const production = (config.NODE_ENV ?? 'development') === 'production';
  const provider = String(config.CALL_PROVIDER ?? (production ? 'none' : 'simulated')).toLowerCase();
  if (!['none', 'simulated', 'snapserve'].includes(provider)) {
    errors.push('CALL_PROVIDER must be none, simulated or snapserve.');
  }
  if (provider === 'simulated' && production) {
    errors.push('CALL_PROVIDER=simulated invents call outcomes (it would mark appointments confirmed without calling anyone). Use it in development only.');
  }
  if (provider === 'snapserve') {
    for (const name of ['SNAPSERVE_API_KEY', 'SNAPSERVE_CONFIRMATION_AGENT_ID', 'SNAPSERVE_BOOKING_AGENT_ID']) {
      if (!config[name]) errors.push(`${name} is required when CALL_PROVIDER=snapserve.`);
    }
    if (String(config.CALL_WEBHOOK_SECRET ?? '').length < 24) {
      errors.push('CALL_WEBHOOK_SECRET (24+ random characters) is required when CALL_PROVIDER=snapserve; it authenticates the post-call webhook.');
    }
  }
  const aiProvider = String(config.AI_PROVIDER ?? (production ? 'none' : 'sample')).toLowerCase();
  if (!['none', 'sample', 'claude'].includes(aiProvider)) {
    errors.push('AI_PROVIDER must be none, sample or claude.');
  }
  if (aiProvider === 'claude' && !config.ANTHROPIC_API_KEY) {
    errors.push('ANTHROPIC_API_KEY is required when AI_PROVIDER=claude.');
  }
  if (config.AI_TIMEOUT_MS !== undefined && !/^[1-9]\d*$/.test(String(config.AI_TIMEOUT_MS))) {
    errors.push('AI_TIMEOUT_MS must be a positive number of milliseconds.');
  }
  const allowed = String(config.CALL_ALLOWED_NUMBERS ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const notIndian = allowed.filter((n) => !/^(\+?91|0)?[6-9]\d{9}$/.test(n.replace(/[\s-]/g, '')));
  if (notIndian.length) errors.push(`CALL_ALLOWED_NUMBERS has numbers that are not 10-digit Indian mobiles: ${notIndian.join(', ')}`);
  const toolsSecret = config.CALL_TOOLS_SECRET;
  if (toolsSecret !== undefined && toolsSecret !== '' && String(toolsSecret).length < 24) {
    errors.push('CALL_TOOLS_SECRET must be 24+ random characters; it authenticates the inbound agent\'s mid-call tools.');
  }
  for (const name of ['SMS_PROVIDER', 'PAYMENT_PROVIDER', 'MESSAGE_PROVIDER']) {
    const value = String(config[name] ?? (production ? 'none' : 'sample')).toLowerCase();
    if (!['none', 'sample'].includes(value)) errors.push(`${name} must be none or sample.`);
  }
  if (config.PUBLIC_WEB_URL !== undefined && config.PUBLIC_WEB_URL !== '' && !/^https?:\/\/\S+$/.test(String(config.PUBLIC_WEB_URL))) {
    errors.push('PUBLIC_WEB_URL must be an http(s) address.');
  }
  if (config.CLINIC_DATE !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(config.CLINIC_DATE))) {
    errors.push('CLINIC_DATE must be YYYY-MM-DD.');
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
