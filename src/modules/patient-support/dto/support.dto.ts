import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
  registerDecorator
} from 'class-validator';
import { CARE_GROUPS, HOLD_REASONS, LANGUAGES, OWNERS, SKIP_REASONS, TICKET_STATES, TICKET_TYPES, TRIGGERS, UPDATE_STATUSES } from '../support-catalogue';
import { CHECKUP_TABS } from '../support-checkups.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** A query-string boolean: only the words "true" and "false" count; anything else fails validation. */
const queryBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export class SupportIdParam {
  @IsMongoId() id: string;
}
export class SupportPatientParam {
  @IsMongoId() patientId: string;
}
export class SupportKeyParam {
  @Matches(/^[a-z0-9:-]{2,60}$/, { message: 'That key is not valid' }) key: string;
}
export class SupportTopicParam {
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'That topic is not valid' }) topic: string;
}

// ---------- tickets ----------

export class TicketListQueryDto {
  @ApiPropertyOptional({ enum: [...TICKET_STATES, 'escalated'] }) @IsOptional() @IsIn([...TICKET_STATES, 'escalated']) shown?: string;
  @ApiPropertyOptional({ enum: TICKET_STATES }) @IsOptional() @IsIn(TICKET_STATES as readonly string[]) state?: string;
  @ApiPropertyOptional({ enum: TICKET_TYPES }) @IsOptional() @IsIn(TICKET_TYPES as readonly string[]) ticketType?: string;
  @ApiPropertyOptional({ enum: OWNERS }) @IsOptional() @IsIn(OWNERS as readonly string[]) owner?: string;
  @ApiPropertyOptional({ description: 'Part of a number, name, phone or question' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ description: 'Opened today' }) @IsOptional() @Transform(queryBool) @IsBoolean() today?: boolean;
  @ApiPropertyOptional({ minimum: 1, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class OpenTicketDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() patientId?: string;
  @ApiProperty({ minLength: 1, maxLength: 80 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) callerName: string;
  @ApiPropertyOptional({ maxLength: 20 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(20) callerPhone?: string;
  @ApiProperty({ enum: TICKET_TYPES }) @IsIn(TICKET_TYPES as readonly string[]) ticketType: string;
  @ApiProperty({ minLength: 1, maxLength: 1000 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) question: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() urgent?: boolean;
  @ApiPropertyOptional({ description: 'Answered on the spot: the ticket is created resolved' }) @IsOptional() @IsBoolean() onTheSpot?: boolean;
  @ApiPropertyOptional({ maxLength: 1000, description: 'The answer given (required when answered on the spot)' })
  @ValidateIf((o: OpenTicketDto) => o.onTheSpot === true || o.resolution !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  resolution?: string;
  @ApiPropertyOptional({ enum: ['desk', 'phone'] }) @IsOptional() @IsIn(['desk', 'phone']) channel?: string;
}

export class TicketNoteDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) body: string;
}

export class TicketStateDto {
  @ApiProperty({ enum: TICKET_STATES }) @IsIn(TICKET_STATES as readonly string[]) state: string;
}

export class TicketHandOnDto {
  @ApiProperty({ enum: TICKET_TYPES }) @IsIn(TICKET_TYPES as readonly string[]) ticketType: string;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class TicketResolveDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) resolution: string;
}

// ---------- updates ----------

export class UpdateListQueryDto {
  @ApiPropertyOptional({ enum: UPDATE_STATUSES }) @IsOptional() @IsIn(UPDATE_STATUSES as readonly string[]) status?: string;
  @ApiPropertyOptional({ enum: [...SKIP_REASONS, ...HOLD_REASONS] })
  @IsOptional()
  @IsIn([...SKIP_REASONS, ...HOLD_REASONS] as readonly string[])
  reason?: string;
  @ApiPropertyOptional({ enum: TRIGGERS }) @IsOptional() @IsIn(TRIGGERS as readonly string[]) trigger?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() patientId?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

// ---------- check-ups ----------

export class CheckupListQueryDto {
  @ApiPropertyOptional({ enum: CHECKUP_TABS }) @IsOptional() @IsIn(CHECKUP_TABS as readonly string[]) tab?: string;
}

export class CheckupAnswersDto {
  @ApiProperty({ enum: CARE_GROUPS }) @IsIn(CARE_GROUPS as readonly string[]) group: string;
  @ApiProperty({ description: 'Question key to choice key' }) @IsObject() answers: Record<string, string>;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) questionText?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 5 }) @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) comment?: string;
}

export class CheckupReviewDto {
  @ApiProperty({ minLength: 1, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note: string;
}

// ---------- feedback ----------

export const FEEDBACK_ASPECTS = ['communication', 'staff', 'waiting', 'facilities'] as const;

/** `aspects`: an object whose keys are only the four known aspects, each a whole number 1 to 5. */
function IsAspects(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isAspects',
      target: target.constructor,
      propertyName,
      options: { message: 'aspects can only hold communication, staff, waiting and facilities, each a whole number from 1 to 5', ...options },
      validator: {
        validate: (value: unknown) =>
          !!value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.entries(value).every(
            ([k, v]) => (FEEDBACK_ASPECTS as readonly string[]).includes(k) && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5
          )
      }
    });
}

export class FeedbackDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() checkupId?: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) overall: number;
  @ApiPropertyOptional({ description: 'communication, staff, waiting, facilities: each 1 to 5' })
  @IsOptional()
  @IsAspects()
  aspects?: Partial<Record<(typeof FEEDBACK_ASPECTS)[number], number>>;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() complaint?: boolean;
}

export class FeedbackListQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(queryBool) @IsBoolean() complaintsOnly?: boolean;
  @ApiPropertyOptional({ minimum: 1, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

// ---------- texts ----------

export class FaqSearchQueryDto {
  @ApiProperty({ maxLength: 80 }) @Transform(trim) @IsString() @MaxLength(80) q: string;
}

export class TemplatePatchDto {
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) en?: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) ta?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() approved?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() taChecked?: boolean;
}

export class FaqPatchDto extends TemplatePatchDto {
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) title?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  keywords?: string[];
}

export class AddFaqDto {
  @ApiProperty({ example: 'lift-timings' })
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'The topic is 2 to 40 lowercase letters, digits or dashes' })
  topic: string;
  @ApiProperty({ maxLength: 80 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) title: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  keywords?: string[];
  @ApiProperty({ maxLength: 1000 }) @IsString() @MinLength(1) @MaxLength(1000) en: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) ta?: string;
}

// ---------- contact and consent ----------

export class ContactPersonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) id?: string;
  @ApiProperty({ minLength: 1, maxLength: 80 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name: string;
  @ApiProperty({ minLength: 1, maxLength: 40 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(40) relation: string;
  @ApiProperty({ maxLength: 20 }) @Transform(trim) @IsString() @MaxLength(20) phone: string;
}

export class ConsentDto {
  @ApiProperty() @IsBoolean() messages: boolean;
  @ApiProperty() @IsBoolean() calls: boolean;
}

export class SaveContactDto {
  @ApiPropertyOptional({ enum: LANGUAGES }) @IsOptional() @IsIn(LANGUAGES as readonly string[]) preferredLanguage?: string;
  @ApiPropertyOptional({ type: [ContactPersonDto], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ContactPersonDto)
  contacts?: ContactPersonDto[];
  @ApiPropertyOptional({ description: 'The id of the contact who gets updates (not with updatesToIndex)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  updatesTo?: string;
  @ApiPropertyOptional({ description: 'The position in `contacts` of the contact who gets updates (not with updatesTo)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  updatesToIndex?: number;
  @ApiPropertyOptional({ type: ConsentDto }) @IsOptional() @ValidateNested() @Type(() => ConsentDto) consent?: ConsentDto;
  @ApiPropertyOptional({ enum: ['desk', 'ward'] }) @IsOptional() @IsIn(['desk', 'ward']) via?: 'desk' | 'ward';
}
