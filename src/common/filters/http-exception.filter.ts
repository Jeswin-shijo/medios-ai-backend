import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Error as MongooseError, mongo } from 'mongoose';

/** Fields of an HttpException's response object that reach the client besides `message`. */
const PASSED_THROUGH = ['code', 'attemptsLeft', 'resendAfterSeconds', 'token'] as const;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly config: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';
    // Machine-readable fields a client acts on (the kiosk reads `code`, `token`...).
    const extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as any).message || exceptionResponse;
      if (exceptionResponse && typeof exceptionResponse === 'object') {
        for (const key of PASSED_THROUGH) {
          if (key in exceptionResponse) extra[key] = (exceptionResponse as Record<string, unknown>)[key];
        }
      }
    } else if (exception instanceof MongooseError.ValidationError) {
      // Missing required fields or values outside a schema enum are client errors.
      status = HttpStatus.BAD_REQUEST;
      message = Object.values(exception.errors).map((e) => e.message);
    } else if (exception instanceof MongooseError.CastError) {
      status = HttpStatus.BAD_REQUEST;
      message = `Invalid value for ${exception.path}: ${JSON.stringify(exception.value)}`;
    } else if (exception instanceof mongo.MongoServerError && exception.code === 11000) {
      status = HttpStatus.CONFLICT;
      message = `A record with this ${Object.keys(exception.keyValue ?? {}).join(', ') || 'key'} already exists`;
    } else if (exception instanceof Error && !this.config.get<boolean>('isProduction')) {
      // Internal error details help in development but are not shown in production.
      message = exception.message;
    }

    this.logger.error(
      `HTTP Status: ${status} Error Message: ${JSON.stringify(message)} Path: ${request.url}`,
      exception instanceof Error ? exception.stack : '',
    );

    response.status(status).json({
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
      ...extra,
    });
  }
}
