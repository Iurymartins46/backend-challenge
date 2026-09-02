export interface SqsTransportMessage {
  /** SQS MessageId. It is transport metadata and is not used as the inbox key. */
  readonly transportMessageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly approximateReceiveCount?: number;
}

export interface SqsReceiveOptions {
  readonly maxNumberOfMessages: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface SqsPublishOptions {
  readonly messageBody: string;
  readonly messageGroupId: string;
  readonly messageDeduplicationId: string;
}

export interface SqsQueuePort {
  receive(queueName: string, options: SqsReceiveOptions): Promise<readonly SqsTransportMessage[]>;
  delete(queueName: string, receiptHandle: string): Promise<void>;
  changeVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void>;
  publish(queueName: string, options: SqsPublishOptions): Promise<void>;
}
