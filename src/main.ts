import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { CLIENT_HEADER } from './common/guards/client-header.guard';

async function bootstrap() {
  const logger = new Logger('MediOS-Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 4000;

  // Global prefix for all API routes: /api/*
  app.setGlobalPrefix('api');

  // Security headers. The API serves JSON (and Swagger UI, whose inline scripts a
  // strict CSP would block), so CSP is left to the web app's host.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  if (configService.get<boolean>('security.trustProxy'))
    app.set('trust proxy', 1);

  // Only the configured web origins may call the API with credentials (the refresh cookie).
  app.enableCors({
    origin: configService.get<string[]>('cors.origins'),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', CLIENT_HEADER],
    credentials: true,
  });

  // Global Validation Pipe for DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Swagger OpenAPI Documentation (off in production unless SWAGGER_ENABLED=true)
  const swaggerEnabled = configService.get<boolean>('swagger.enabled');
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('MediOS AI - Clinical Workstation API')
      .setDescription(
        'Enterprise Healthcare & Hospital Management System REST APIs powered by NestJS and MongoDB',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .addTag('Authentication', 'Login, registration and user session')
      .addTag('Patients', 'Patient records, vitals, summary, and demographics')
      .addTag('Appointments', 'Daily schedules, queue management, and booking')
      .addTag(
        'Consultations & EMR',
        'SOAP notes, ICD-10 codes, and AI clinical suggestions',
      )
      .addTag(
        'Prescriptions',
        'Digital Rx builder, interaction checking, and alternatives',
      )
      .addTag('Medications', 'Medication reconciliation and adherence tracking')
      .addTag(
        'Lab Reports',
        'Laboratory parameters, findings, and longitudinal trends',
      )
      .addTag(
        'Imaging & RIS',
        'PACS/DICOM radiological imaging studies and reports',
      )
      .addTag(
        'Billing & Invoices',
        'Hospital billing, payments, and financial analytics',
      )
      .addTag('Follow-ups & Recalls', 'Patient recall reminders and scheduling')
      .addTag('Patient Timeline', 'Longitudinal clinical encounter timeline')
      .addTag(
        'Clinical Documents',
        'Medical certificates, discharge summaries, and consent forms',
      )
      .addTag(
        'Vitals & Trends',
        'Vital signs logging and multi-parameter clinical charts',
      )
      .addTag(
        'Tasks & Clinical Alerts',
        'Clinical tasks, abnormal findings, and alerts',
      )
      .addTag(
        'Messages & Teleconsultation',
        'Inter-departmental and patient messaging',
      )
      .addTag(
        'Hospital Knowledge & Clinical Guidelines',
        'Evidence protocols and hospital SOPs',
      )
      .addTag(
        'Voice to Notes (Ambient AI Scribe)',
        'Ambient medical conversation transcription and SOAP extraction',
      )
      .addTag(
        'Dashboard',
        'Aggregated clinical KPIs, schedules, and patient flow statistics',
      )
      .addTag(
        'Settings & Hospital Configuration',
        'Hospital profile, staff, and AI configurations',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(port);
  logger.log(`=======================================================`);
  logger.log(
    `🚀 MediOS AI Backend is running on: http://localhost:${port}/api`,
  );
  if (swaggerEnabled)
    logger.log(
      `📚 Interactive Swagger API Docs:    http://localhost:${port}/api/docs`,
    );
  logger.log(`=======================================================`);
}
bootstrap();
