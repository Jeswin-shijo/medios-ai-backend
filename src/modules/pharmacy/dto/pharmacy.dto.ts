import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { DOSES_PER_DAY, ROUTE_LABEL } from '../pharmacy-catalogue';
import { LINE_STATUSES, QUERY_KINDS } from '../schemas/pharmacy-line.schema';
import { ADJUST_REASONS } from '../schemas/pharmacy-movement.schema';
import { PHARMACY_PRIORITIES } from '../schemas/pharmacy-order.schema';

const FREQUENCIES = Object.keys(DOSES_PER_DAY);
const ROUTES = Object.keys(ROUTE_LABEL);
const STORE_KEYS = ['main', 'er'];
const SETTINGS = ['ER', 'Ward', 'OPD'];
const OUTCOMES = ['change', 'keep', 'cancel', 'stop', 'switch', 'wait'];
/** A batch number: 1 to 40 characters of letters, digits, ".", "/" and "-", with single inner spaces allowed (the ends are trimmed first). */
const BATCH_NO = /^[A-Za-z0-9./-](?:[A-Za-z0-9./ -]{0,38}[A-Za-z0-9./-])?$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The value must not be 0 (an adjustment that changes nothing). */
function NotZero(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'notZero',
      target: target.constructor,
      propertyName,
      options: { message: 'change must not be 0', ...options },
      validator: { validate: (v: unknown) => v !== 0 },
    });
}

export class IdParam {
  @IsMongoId()
  id: string;
}

/** `:id` and `:key` of a flag. Real keys look like `kidney.0-30` or `clash.amoxicillin-clavulanate`. */
export class FlagParam extends IdParam {
  @Matches(/^[a-z0-9.-]{1,60}$/, { message: 'key must be 1 to 60 characters of a-z, 0-9, "." or "-"' })
  key: string;
}

/** A reason of 1 to 300 characters after trimming: cancel and reject. */
export class PharmacyReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class ConfirmDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

/** One medicine line. A STAT dose has no durationDays; any other frequency needs 1 to 90 days. */
export class LineDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(60) medicine: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) product: string;
  @ApiProperty({ minimum: 0, maximum: 100000 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsPositive() @Max(100000) dose: number;
  @ApiProperty({ enum: ROUTES }) @IsIn(ROUTES) route: string;
  @ApiProperty({ enum: FREQUENCIES }) @IsIn(FREQUENCIES) frequency: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 90 }) @IsOptional() @IsInt() @Min(1) @Max(90) durationDays?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ type: ConfirmDto }) @IsOptional() @ValidateNested() @Type(() => ConfirmDto) confirm?: ConfirmDto;
}

/** The new dose of a Change answer. The medicine follows from the product. */
export class ChangeDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) product: string;
  @ApiProperty({ minimum: 0, maximum: 100000 }) @IsNumber({ allowNaN: false, allowInfinity: false }) @IsPositive() @Max(100000) dose: number;
  @ApiProperty({ enum: ROUTES }) @IsIn(ROUTES) route: string;
  @ApiProperty({ enum: FREQUENCIES }) @IsIn(FREQUENCIES) frequency: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 90 }) @IsOptional() @IsInt() @Min(1) @Max(90) durationDays?: number;
  @ApiPropertyOptional({ type: ConfirmDto }) @IsOptional() @ValidateNested() @Type(() => ConfirmDto) confirm?: ConfirmDto;
}

export class CheckDto {
  @ApiProperty() @IsMongoId() patientId: string;
  @ApiProperty({ type: [LineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}

/** A check that previews the answer to a query: the line being replaced is left out of the comparison. */
export class PreviewCheckDto extends CheckDto {
  @ApiPropertyOptional({ description: 'A line of this patient that the new lines would replace' }) @IsOptional() @IsMongoId() replacingLineId?: string;
}

export class PharmacyOrderDto extends CheckDto {
  @ApiProperty({ enum: PHARMACY_PRIORITIES }) @IsIn(PHARMACY_PRIORITIES as readonly string[]) priority: 'stat' | 'urgent' | 'routine';
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class AnswerDto {
  @ApiProperty({ description: 'The seq of the query being answered' }) @IsInt() @Min(0) querySeq: number;
  @ApiProperty({ enum: OUTCOMES }) @IsIn(OUTCOMES) outcome: string;
  @ApiPropertyOptional({ description: 'Required (1 to 300 characters) for keep, cancel and stop' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional({ type: ChangeDto }) @IsOptional() @ValidateNested() @Type(() => ChangeDto) change?: ChangeDto;
  @ApiPropertyOptional({ type: LineDto }) @IsOptional() @ValidateNested() @Type(() => LineDto) switchTo?: LineDto;
}

export class ApproveDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allergyReviewed?: boolean;
}

export class QueryDto {
  @ApiProperty({ enum: QUERY_KINDS }) @IsIn(QUERY_KINDS as readonly string[]) kind: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) question: string;
}

export class IssueDto {
  @ApiPropertyOptional({ enum: STORE_KEYS }) @IsOptional() @IsIn(STORE_KEYS) store?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Matches(BATCH_NO, { message: 'batchNo must be 1 to 40 characters of letters, digits, ".", "/", "-" or inner spaces' }) batchNo?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 10000 }) @IsOptional() @IsInt() @Min(1) @Max(10000) quantity?: number;
}

export class ReceiveDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) product: string;
  @ApiProperty({ enum: STORE_KEYS }) @IsIn(STORE_KEYS) store: string;
  @ApiProperty() @Transform(trim) @IsString() @Matches(BATCH_NO, { message: 'batchNo must be 1 to 40 characters of letters, digits, ".", "/", "-" or inner spaces' }) batchNo: string;
  @ApiProperty({ example: '2027-12-31' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiry must be YYYY-MM-DD' }) expiry: string;
  @ApiProperty({ minimum: 1, maximum: 10000 }) @IsInt() @Min(1) @Max(10000) quantity: number;
}

/** A whole-number change that is not 0. */
export class AdjustDto {
  @ApiProperty({ minimum: -100000, maximum: 100000 })
  @IsInt()
  @Min(-100000)
  @Max(100000)
  @NotZero()
  change: number;
  @ApiProperty({ enum: ADJUST_REASONS }) @IsIn(ADJUST_REASONS as readonly string[]) reason: string;
}

export class LevelDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) product: string;
  @ApiProperty({ enum: STORE_KEYS }) @IsIn(STORE_KEYS) store: string;
  @ApiProperty({ minimum: 0, maximum: 100000 }) @IsInt() @Min(0) @Max(100000) reorderLevel: number;
}

export class PharmacySnapshotQueryDto {
  @ApiPropertyOptional({ enum: ['24h', '7d'], default: '24h' }) @IsOptional() @IsIn(['24h', '7d']) range?: '24h' | '7d';
}

export class OrdersQueryDto {
  @ApiPropertyOptional({ enum: LINE_STATUSES }) @IsOptional() @IsIn(LINE_STATUSES as readonly string[]) status?: string;
  @ApiPropertyOptional({ description: 'Order number, UHID or patient name' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: SETTINGS }) @IsOptional() @IsIn(SETTINGS) setting?: 'ER' | 'Ward' | 'OPD';
  @ApiPropertyOptional({ minimum: 1, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class SinceQueryDto {
  @ApiPropertyOptional({ description: 'An ISO time; older lines are left out' }) @IsOptional() @IsString() @MaxLength(40) @Matches(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, { message: 'since must be an ISO date or time' }) since?: string;
}

export class WorklistQueryDto {
  @ApiProperty({ enum: ['check', 'issue', 'queries'] }) @IsIn(['check', 'issue', 'queries']) view: 'check' | 'issue' | 'queries';
}

export class StoreQueryDto {
  @ApiPropertyOptional({ enum: STORE_KEYS }) @IsOptional() @IsIn(STORE_KEYS) store?: string;
}

export class MovementsQueryDto extends StoreQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) product?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 500 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
