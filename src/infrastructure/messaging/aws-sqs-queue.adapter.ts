import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type {
  SqsPublishOptions,
  SqsApproximateMessageCount,
  SqsQueuePort,
  SqsReceiveOptions,
  SqsTransportMessage,
} from './sqs-queue.port';
import { withTelemetrySpan } from '../telemetry';

export class AwsSqsQueueAdapter implements SqsQueuePort {
  private readonly queueUrls = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async receive(
    queueName: string,
    options: SqsReceiveOptions,
  ): Promise<readonly SqsTransportMessage[]> {
    const output = await withTelemetrySpan(
      'sqs.receive',
      { 'messaging.system': 'aws.sqs', 'messaging.destination.name': queueName },
      async () =>
        this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.queueUrl(queueName),
            MaxNumberOfMessages: options.maxNumberOfMessages,
            WaitTimeSeconds: options.waitTimeSeconds,
            VisibilityTimeout: options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          options.signal === undefined ? undefined : { abortSignal: options.signal },
        ),
    );

    return (output.Messages ?? []).map((message) => ({
      transportMessageId: message.MessageId ?? '',
      receiptHandle: message.ReceiptHandle ?? '',
      body: message.Body ?? '',
      ...(message.Attributes?.ApproximateReceiveCount === undefined
        ? {}
        : {
            approximateReceiveCount: Number(message.Attributes.ApproximateReceiveCount),
          }),
    }));
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await withTelemetrySpan(
      'sqs.delete',
      { 'messaging.system': 'aws.sqs', 'messaging.destination.name': queueName },
      async () =>
        this.client.send(
          new DeleteMessageCommand({
            QueueUrl: await this.queueUrl(queueName),
            ReceiptHandle: receiptHandle,
          }),
        ),
    );
  }

  async changeVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await withTelemetrySpan(
      'sqs.change_visibility',
      { 'messaging.system': 'aws.sqs', 'messaging.destination.name': queueName },
      async () =>
        this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: await this.queueUrl(queueName),
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: visibilityTimeoutSeconds,
          }),
        ),
    );
  }

  async publish(queueName: string, options: SqsPublishOptions): Promise<void> {
    await withTelemetrySpan(
      'sqs.publish',
      { 'messaging.system': 'aws.sqs', 'messaging.destination.name': queueName },
      async () =>
        this.client.send(
          new SendMessageCommand({
            QueueUrl: await this.queueUrl(queueName),
            MessageBody: options.messageBody,
            MessageGroupId: options.messageGroupId,
            MessageDeduplicationId: options.messageDeduplicationId,
          }),
        ),
    );
  }

  async getApproximateMessageCount(queueName: string): Promise<SqsApproximateMessageCount> {
    const output = await withTelemetrySpan(
      'sqs.get_queue_attributes',
      { 'messaging.system': 'aws.sqs', 'messaging.destination.name': queueName },
      async () =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queueUrl(queueName),
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
            ],
          }),
        ),
    );
    const visible = approximateCount(output.Attributes?.ApproximateNumberOfMessages);
    const inFlight = approximateCount(output.Attributes?.ApproximateNumberOfMessagesNotVisible);
    const delayed = approximateCount(output.Attributes?.ApproximateNumberOfMessagesDelayed);

    return { visible, inFlight, delayed, total: visible + inFlight + delayed };
  }

  private async queueUrl(queueName: string): Promise<string> {
    const cachedUrl = this.queueUrls.get(queueName);
    if (cachedUrl !== undefined) {
      return cachedUrl;
    }

    const output = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (output.QueueUrl === undefined) {
      throw new Error(`SQS queue URL was not returned for ${queueName}.`);
    }

    this.queueUrls.set(queueName, output.QueueUrl);
    return output.QueueUrl;
  }
}

function approximateCount(value: string | undefined): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
