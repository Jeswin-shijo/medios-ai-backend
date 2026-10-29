import { IsBoolean, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DEVICE_KINDS } from '../schemas/queue-display.schema';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class IssueTokenDto {
  @ApiPropertyOptional({ example: 'MHK202500322', description: 'Required unless appointmentId is given' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  uhid?: string;

  @ApiPropertyOptional({ description: "Today's appointment being checked in; found automatically from the UHID when omitted" })
  @IsOptional()
  @IsMongoId()
  appointmentId?: string;

  @ApiPropertyOptional({ description: "The doctor whose line to join; the default doctor when omitted" })
  @IsOptional()
  @IsMongoId()
  doctorId?: string;

  @ApiPropertyOptional({ description: 'Serve ahead of the others (elderly, pregnant, unwell)' })
  @IsOptional()
  @IsBoolean()
  priority?: boolean;

  @ApiPropertyOptional({ example: 'Wheelchair' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}

export class CallTokenDto {
  @ApiProperty({ example: 'Consultation Room', description: 'One of the rooms in the queue settings' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  counter: string;

  @ApiPropertyOptional({
    description:
      "The token this room is finishing (its current one). Required while the room has a called token, so a double press cannot skip a patient.",
  })
  @IsOptional()
  @IsMongoId()
  finish?: string;
}

export class QueueQueryDto {
  @IsOptional()
  @Matches(ISO_DAY, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class CreateDisplayDto {
  @ApiProperty({ example: 'Waiting room TV' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name: string;

  @ApiPropertyOptional({ enum: DEVICE_KINDS, default: 'display', description: 'display: shows the queue; kiosk: patients tap a card to take a token' })
  @IsOptional()
  @IsIn(DEVICE_KINDS)
  kind?: (typeof DEVICE_KINDS)[number];

  @ApiPropertyOptional({ description: 'Kiosk only: print a token slip after each tap' })
  @IsOptional()
  @IsBoolean()
  printSlips?: boolean;
}

export class UpdateDisplayDto {
  @ApiPropertyOptional({ example: 'Entrance kiosk' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ description: 'Kiosk only: print a token slip after each tap' })
  @IsOptional()
  @IsBoolean()
  printSlips?: boolean;
}

/** What the USB card reader typed: the card's serial number. */
export class CardTapDto {
  @ApiProperty({ example: '04A1B2C3' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  cardId: string;
}

export class LinkCardDto extends CardTapDto {
  @ApiProperty({ example: 'MHK202500324' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  uhid: string;

  @ApiPropertyOptional({ description: 'Move the card from the patient it is linked to now' })
  @IsOptional()
  @IsBoolean()
  reassign?: boolean;
}

export class CardsQueryDto {
  @ApiProperty({ example: 'MHK202500324' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  uhid: string;
}
