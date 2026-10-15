import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { tableDefinition } from '../../shared/db/schema.js';
import { createDocClient } from '../../shared/db/client.js';
import { createStore } from '../../shared/db/store.js';

export async function createTestStore() {
  const doc = createDocClient();
  const tableName = `test-${randomUUID()}`;
  await doc.send(new CreateTableCommand(tableDefinition(tableName)));
  return {
    store: createStore({ doc, tableName }),
    doc,
    tableName,
    cleanup: () => doc.send(new DeleteTableCommand({ TableName: tableName })),
  };
}
