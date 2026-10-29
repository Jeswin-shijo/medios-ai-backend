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
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class IdParam {
  @IsMongoId()
  id: string;
}

export class RuleKeyParam {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  key: string;
}

class PagedQueryDto {
  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Only items before this id or ISO time' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  before?: string;
}

export class CaseQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'closed'] })
  @IsOptional()
  @IsIn(['open', 'closed'])
  state?: 'open' | 'closed';
}

export class MessageQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: 'A case id' })
  @IsOptional()
  @IsMongoId()
  case?: string;

  @ApiPropertyOptional({ example: 'bed.waiting' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;

  @ApiPropertyOptional({ example: 'bed' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  agent?: string;

  @ApiPropertyOptional({ description: 'true: only messages that still wait for an agent' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  openWork?: boolean;
}

export class SnapshotRangeDto {
  @ApiPropertyOptional({ enum: ['24h', '7d'], default: '24h' })
  @IsOptional()
  @IsIn(['24h', '7d'])
  range?: '24h' | '7d';
}

export class ApprovalQueryDto {
  @ApiPropertyOptional({ example: 'open' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  state?: string;
}

export class AskDto {
  @ApiProperty({ example: 'show agent workload', maxLength: 500 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question: string;
}

export class ActDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';
}

export class ReassignTargetDto {
  @ApiProperty({ enum: ['title', 'role'] })
  @IsIn(['title', 'role'])
  kind: 'title' | 'role';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  key: string;
}

export class ReassignDto {
  @ApiProperty({ type: ReassignTargetDto })
  @ValidateNested()
  @Type(() => ReassignTargetDto)
  target: ReassignTargetDto;

  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note: string;
}

export class SetRuleDto {
  @ApiProperty()
  @IsBoolean()
  value: boolean;
}

export class LadderStepDto {
  @ApiProperty({ description: 'A duty title key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  title: string;

  @ApiProperty({ example: 15 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  waitMinutes: number;
}

export class LadderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  key: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @ApiProperty({ type: [LadderStepDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LadderStepDto)
  steps: LadderStepDto[];
}

export class DutyTitleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  key: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @ApiProperty({ description: 'User ids of the people who hold this title', type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  holders: string[];
}
