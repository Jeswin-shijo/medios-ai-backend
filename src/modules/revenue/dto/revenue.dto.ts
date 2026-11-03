import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested, registerDecorator } from 'class-validator';
import { isoDate, parseIsoDay } from '../../../common/utils/clinic-time';
import { PRICE_CATEGORIES, PRICE_CODE_PATTERN } from '../revenue-catalogue';
import { CORRECTION_KINDS } from '../schemas/correction.schema';
import { PAYMENT_KINDS } from '../schemas/payment.schema';

/** Whole rupees: 1 to 10,00,000. */
const MAX_AMOUNT = 1_000_000;
const MODES = ['cash', 'upi', 'card'];
const BILL_STATES = ['open', 'final', 'settled'];
const BILL_KINDS = ['opd', 'er', 'admission', 'walk-in'];
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** YYYY-MM-DD naming a real day. */
function RealDay() {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'realDay',
      target: target.constructor,
      propertyName,
      options: { message: `${propertyName} must be a date as YYYY-MM-DD` },
      validator: { validate: (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isoDate(parseIsoDay(v)) === v },
    });
}

export class IdParam {
  @IsMongoId() id: string;
}

export class BillIdParam {
  @IsMongoId() billId: string;
}

// ---------- queries ----------

export class OverviewQueryDto {
  @IsOptional() @RealDay() day?: string;
}

export class SnapshotQueryDto {
  @IsOptional() @IsIn(['24h', '7d']) range?: string;
}

export class BillsQueryDto {
  @IsOptional() @IsIn(BILL_STATES) state?: string;
  @IsOptional() @IsIn(BILL_KINDS) kind?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class PaymentsQueryDto {
  @IsOptional() @RealDay() day?: string;
}

export class PriceListQueryDto {
  @IsOptional() @IsIn([...PRICE_CATEGORIES]) category?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

// ---------- bodies ----------

/** A reason, 1 to 300 characters after trimming. */
export class ReasonDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class PaymentDto {
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  @IsIn(MODES) mode: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsIn([...PAYMENT_KINDS]) kind: string;
}

export class RefundPayDto {
  @IsIn(MODES) mode: string;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
}

export class MissedChargeDto {
  @IsOptional() @Matches(PRICE_CODE_PATTERN) code?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsIn([...PRICE_CATEGORIES]) category: string;
  @IsInt() @Min(1) @Max(1000) qty: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class CorrectionDto {
  @IsOptional() @IsMongoId() lineId?: string;
  @IsIn([...CORRECTION_KINDS]) kind: string;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_AMOUNT) amount?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) qty?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) percent?: number;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class EstimateExtraDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
}

export class EstimateEditDto {
  @IsOptional() @IsInt() @Min(1) @Max(60) days?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => EstimateExtraDto) extra?: EstimateExtraDto[];
}

export class PriceItemDto {
  @Matches(PRICE_CODE_PATTERN) code: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsIn([...PRICE_CATEGORIES]) category: string;
  @IsOptional() @IsString() @MaxLength(30) unit?: string;
  /** 0 is allowed: it marks an item that still needs a price. */
  @IsInt() @Min(0) @Max(MAX_AMOUNT) price: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
