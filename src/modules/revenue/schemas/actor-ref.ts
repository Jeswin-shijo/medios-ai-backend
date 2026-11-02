import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Who did it: a person or an agent. Names are for staff screens only. */
@Schema({ _id: false })
export class ActorRef {
  @Prop({ default: '' })
  id: string;

  @Prop({ required: true })
  name: string;
}
export const ActorRefSchema = SchemaFactory.createForClass(ActorRef);
