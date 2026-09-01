import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryColumn({ type: 'varchar', name: 'consumer_name', length: 100 })
  consumerName!: string;

  @PrimaryColumn({ type: 'varchar', name: 'message_id', length: 255 })
  messageId!: string;

  @Column({ type: 'char', name: 'payload_hash', length: 64 })
  payloadHash!: string;

  @Column({ type: 'timestamptz', name: 'received_at' })
  receivedAt!: Date;

  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
