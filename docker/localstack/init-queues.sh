#!/bin/sh

set -eu

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localstack:4566}"
SQS_COMMAND_QUEUE_NAME="${SQS_COMMAND_QUEUE_NAME:?SQS_COMMAND_QUEUE_NAME is required}"
SQS_COMMAND_DLQ_NAME="${SQS_COMMAND_DLQ_NAME:?SQS_COMMAND_DLQ_NAME is required}"
SQS_EVENTS_QUEUE_NAME="${SQS_EVENTS_QUEUE_NAME:?SQS_EVENTS_QUEUE_NAME is required}"
SQS_COMMAND_MAX_RECEIVE_COUNT="${SQS_COMMAND_MAX_RECEIVE_COUNT:?SQS_COMMAND_MAX_RECEIVE_COUNT is required}"

case "$SQS_COMMAND_MAX_RECEIVE_COUNT" in
  *[!0-9]* | '')
    printf '%s\n' 'SQS_COMMAND_MAX_RECEIVE_COUNT must be a positive integer.' >&2
    exit 1
    ;;
esac

if [ "$SQS_COMMAND_MAX_RECEIVE_COUNT" -lt 1 ]; then
  printf '%s\n' 'SQS_COMMAND_MAX_RECEIVE_COUNT must be a positive integer.' >&2
  exit 1
fi

if command -v awslocal >/dev/null 2>&1; then
  aws_cmd() {
    awslocal --endpoint-url "$AWS_ENDPOINT_URL" --region "$AWS_REGION" "$@"
  }
else
  aws_cmd() {
    aws --endpoint-url "$AWS_ENDPOINT_URL" --region "$AWS_REGION" "$@"
  }
fi

fifo_attributes='{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

ensure_queue() {
  queue_name="$1"
  queue_url=""

  if queue_url="$(aws_cmd sqs get-queue-url \
    --queue-name "$queue_name" \
    --query 'QueueUrl' \
    --output text 2>/dev/null)"; then
    printf '%s\n' "$queue_url"
    return 0
  fi

  aws_cmd sqs create-queue \
    --queue-name "$queue_name" \
    --attributes "$fifo_attributes" \
    --query 'QueueUrl' \
    --output text
}

dlq_url="$(ensure_queue "$SQS_COMMAND_DLQ_NAME")"
commands_url="$(ensure_queue "$SQS_COMMAND_QUEUE_NAME")"
ensure_queue "$SQS_EVENTS_QUEUE_NAME" >/dev/null

dlq_arn="$(aws_cmd sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

redrive_attributes="$(printf '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"%s\",\"maxReceiveCount\":\"%s\"}"}' "$dlq_arn" "$SQS_COMMAND_MAX_RECEIVE_COUNT")"
aws_cmd sqs set-queue-attributes \
  --queue-url "$commands_url" \
  --attributes "$redrive_attributes"

printf '%s\n' 'LocalStack SQS queues are ready.'
