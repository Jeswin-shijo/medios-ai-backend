export default () => ({
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'medios_clinical_jwt_secret_key_2026_xyz',
    expiresIn: process.env.JWT_EXPIRATION || '7d',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
});
