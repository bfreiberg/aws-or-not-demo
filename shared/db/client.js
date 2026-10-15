import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export function createDocClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const client = new DynamoDBClient(endpoint ? { endpoint } : {});
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}
