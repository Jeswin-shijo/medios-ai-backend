import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  registerDecorator,
  validateSync,
} from 'class-validator';
import { LineDto } from '../../pharmacy/dto/pharmacy.dto';
import { CONDITIONS, Condition, DISCHARGE_KINDS, DischargeKind } from '../discharge-catalogue';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The literal "none", or an object that passes `cls`'s own rules (the take-home and follow-up choices). */
function NoneOr(cls: new () => object, what: string) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'noneOr',
      target: target.constructor,
      propertyName,
      options: { message: `${propertyName} must be "none" or ${what}` },
      validator: { validate: (v: unknown) => v === 'none' || (isObj(v) && validateSync(plainToInstance(cls, v)).length === 0) },
    });
}

export class PlanIdParam {
  @IsMongoId() planId: string;
}

export class DischargeOrderIdParam {
  @IsMongoId() id: string;
}

/** 1 to 10 take-home medicines, each a Pharmacy line. */
export class TakeHomeDto {
  @ApiProperty({ type: [LineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}

/** "In N days with" a doctor or a department (Scheduling's follow-up order). */
export class FollowUpChoiceDto {
  @ApiProperty({ minimum: 1, maximum: 365 }) @IsInt() @Min(1) @Max(365) inDays: number;
  @ApiPropertyOptional({ description: 'An OP doctor id' }) @IsOptional() @IsMongoId() doctorId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(20) departmentCode?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

/** `POST /discharge/plans/:planId/order`. The service checks which fields each kind needs. */
export class OrderDischargeDto {
  @ApiProperty({ enum: DISCHARGE_KINDS }) @IsIn(DISCHARGE_KINDS as readonly string[]) kind: DischargeKind;
  @ApiPropertyOptional({ description: 'Clinic time, today or tomorrow; default now + the order-to-leaving target' })
  @IsOptional() @IsISO8601({ strict: true }) plannedLeaveAt?: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) diagnosis: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS as readonly string[]) condition?: Condition;
  @ApiPropertyOptional({ description: 'Died only' }) @IsOptional() @IsISO8601({ strict: true }) timeOfDeath?: string;
  @ApiPropertyOptional({ description: 'Died only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) causeOfDeath?: string;
  @ApiPropertyOptional({ description: 'Transfer only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) receivingHospital?: string;
  @ApiPropertyOptional({ description: 'Transfer only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) transferReason?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
  @ApiPropertyOptional({ description: '"none", or { lines }' }) @IsOptional() @NoneOr(TakeHomeDto, '{ lines: 1 to 10 medicines }') takeHome?: TakeHomeDto | 'none';
  @ApiPropertyOptional({ description: '"none", or { inDays, doctorId?, departmentCode?, note? }' })
  @IsOptional() @NoneOr(FollowUpChoiceDto, '{ inDays, doctorId?, departmentCode?, note? }') followUp?: FollowUpChoiceDto | 'none';
}

/** `PATCH /discharge/orders/:id`: only what is sent changes. */
export class EditDischargeOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) plannedLeaveAt?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) diagnosis?: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS as readonly string[]) condition?: Condition;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
  @ApiPropertyOptional({ type: TakeHomeDto }) @IsOptional() @ValidateNested() @Type(() => TakeHomeDto) takeHome?: TakeHomeDto;
  @ApiPropertyOptional({ type: FollowUpChoiceDto }) @IsOptional() @ValidateNested() @Type(() => FollowUpChoiceDto) followUp?: FollowUpChoiceDto;
}

/** Cancelling an order: 1 to 300 characters, kept on the order and never sent in a message. */
export class DischargeReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

/** `POST /discharge/orders/check`: the live safety flags of take-home lines for the plan's patient. */
export class DischargeCheckDto {
  @ApiProperty() @IsMongoId() planId: string;
  @ApiProperty({ type: [LineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}
