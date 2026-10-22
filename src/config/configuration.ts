const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const list = (value: string | undefined, fallback: string) =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export default () => ({
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv,
  isProduction,
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital',
  },
  jwt: {
    // Required and validated at startup (see env.validation.ts); there is no fallback secret.
    secret: process.env.JWT_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    issuer: process.env.JWT_ISSUER || 'medios-api',
    audience: process.env.JWT_AUDIENCE || 'medios-clients',
  },
  refreshToken: {
    ttlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10) || 7,
    cookieName: 'medios_rt',
    // Secure cookies need HTTPS; on by default in production.
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    // 'none' (with secure) when the web app is served from another site than the API.
    cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax') as 'lax' | 'strict' | 'none',
  },
  security: {
    maxFailedLogins: parseInt(process.env.MAX_FAILED_LOGINS, 10) || 5,
    lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES, 10) || 15,
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    // Set when running behind a reverse proxy so rate limits see client IPs.
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
  cors: {
    origins: list(process.env.CORS_ORIGIN, 'http://localhost:5173'),
  },
  swagger: {
    enabled: process.env.SWAGGER_ENABLED ? process.env.SWAGGER_ENABLED === 'true' : !isProduction,
  },
});
