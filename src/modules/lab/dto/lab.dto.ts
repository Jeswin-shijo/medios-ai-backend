import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { LAB_TESTS } from '../lab-catalogue';
import { REJECT_REASONS } from '../lab-bench.service';
import { LAB_PRIORITIES } from '../schemas/lab-request.schema';

const LAB_AREAS = ['ER', 'Ward', 'OPD'];
const TEST_KEYS = LAB_TESTS.map((t) => t.key);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimUpper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** parameter name -> whether it takes text. A name that is numeric in one test and text in another is treated as numeric. */
const PARAM_IS_TEXT = (() => {
  const m = new Map<string, boolean>();
  for (const t of LAB_TESTS) for (const p of t.params) m.set(p.name, (m.get(p.name) ?? true) && !!p.text);
  return m;
})();
const MAX_VALUE = 1_000_000;
const MAX_TEXT = 200;

/** A plain object of known parameter names. Numbers must be finite and within ±10⁶; text must be 1 to 200 characters. */
@ValidatorConstraint({ name: 'labValues', async: false })
export class LabValuesConstraint implements ValidatorConstraintInterface {
  private problem(v: unknown): string | null {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return 'values must be an object';
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 20) return 'values must have 1 to 20 entries';
    for (const [name, value] of entries) {
      if (!PARAM_IS_TEXT.has(name)) return `unknown parameter "${name.slice(0, 40)}"`;
      if (PARAM_IS_TEXT.get(name)) {
        if (typeof value !== 'string' || value.trim().length < 1 || value.length > MAX_TEXT) return `${name} must be text of 1 to ${MAX_TEXT} characters`;
      } else if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_VALUE) {
        return `${name} must be a number between -${MAX_VALUE} and ${MAX_VALUE}`;
      }
    }
    return null;
  }
  validate(v: unknown) {
    return this.problem(v) === null;
  }
  defaultMessage(args?: { value?: unknown }) {
    return this.problem(args?.value) ?? 'values are not valid';
  }
}

export class IdParam {
  @IsMongoId()
  id: string;
}

export class OrderDto {
  @ApiProperty() @IsMongoId() patientId: string;
  @ApiProperty({ enum: TEST_KEYS, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsIn(TEST_KEYS, { each: true })
  tests: string[];
  @ApiProperty({ enum: LAB_PRIORITIES }) @IsIn(LAB_PRIORITIES as readonly string[]) priority: 'stat' | 'urgent' | 'routine';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 72, description: 'Also order a repeat this many hours later' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  repeatAfterHours?: number;
}

/** One reason, 1 to 300 characters after trimming. Used to cancel, mark not collected and send back. */
export class ReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class CollectDto {
  @ApiProperty({ example: 'S-261030-0001' })
  @Transform(trimUpper)
  @IsString()
  @Matches(/^S-\d{6}-\d{4}$/, { message: 'sampleNumber must look like S-YYMMDD-NNNN' })
  sampleNumber: string;
}

@ValidatorConstraint({ name: 'noteForOther', async: false })
class NoteForOther implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments) {
    const o = args.object as RejectDto;
    return o.reason !== 'other' || (typeof o.note === 'string' && o.note.trim().length > 0);
  }
  defaultMessage() {
    return 'A note is required when the reason is "other"';
  }
}

export class RejectDto {
  @ApiProperty({ enum: REJECT_REASONS })
  @IsIn(REJECT_REASONS as readonly string[])
  @Validate(NoteForOther)
  reason: string;
  @ApiPropertyOptional({ description: 'Required when the reason is "other"' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ResultsDto {
  @ApiProperty({ description: 'Parameter name -> number (numeric parameters) or text' })
  @Validate(LabValuesConstraint)
  values: Record<string, number | string>;
}

export class AmendDto extends ResultsDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

export class AckDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class SnapshotQueryDto {
  @ApiPropertyOptional({ enum: ['24h', '7d'], default: '24h' }) @IsOptional() @IsIn(['24h', '7d']) range?: '24h' | '7d';
}

export class AreaQueryDto {
  @ApiPropertyOptional({ enum: LAB_AREAS }) @IsOptional() @IsIn(LAB_AREAS) area?: 'ER' | 'Ward' | 'OPD';
}

export class RequestsQueryDto extends AreaQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'done'] }) @IsOptional() @IsIn(['open', 'done']) status?: 'open' | 'done';
  @ApiPropertyOptional({ description: 'Request number, UHID or patient name' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
}
