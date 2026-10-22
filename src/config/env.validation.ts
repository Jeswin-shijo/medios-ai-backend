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

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
