import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MessagesService } from './messages.service';

@ApiTags('Messages & Teleconsultation')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('threads')
  @ApiOperation({ summary: 'Get chat threads filtered by category' })
  @ApiQuery({ name: 'category', required: false })
  async findAll(@Query('category') category?: string) {
    return this.messagesService.findAll(category);
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'Get message history of a thread' })
  async findOne(@Param('id') id: string) {
    return this.messagesService.findOne(id);
  }

  @Post('threads/:id/send')
  @ApiOperation({ summary: 'Send a message in a thread' })
  async sendMessage(
    @Param('id') id: string,
    @Body('text') text: string,
    @Body('sender') sender?: string,
    @Body('attachment') attachment?: any,
  ) {
    return this.messagesService.sendMessage(
      id,
      sender || 'doctor',
      text,
      attachment,
    );
  }

  @Patch('threads/:id/read')
  @ApiOperation({ summary: 'Mark thread as read' })
  async markAsRead(@Param('id') id: string) {
    return this.messagesService.markAsRead(id);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get total unread messages count' })
  async getUnreadCount() {
    const count = await this.messagesService.getUnreadCount();
    return { unreadCount: count };
  }
}
