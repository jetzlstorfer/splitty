import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { StorageSource } from "./config";

export const authTableName = "SplittyAuth";
export const ledgerTableName = "SplittyLedger";

export interface DataTables { auth: TableClient; ledger: TableClient }

const insecureEmulator = /TableEndpoint=http:\/\/|UseDevelopmentStorage=true/i;

export function openTable(storage: StorageSource, name: string): TableClient {
  if (storage.kind === "connectionString") {
    return TableClient.fromConnectionString(storage.connection, name, {
      allowInsecureConnection: insecureEmulator.test(storage.connection)
    });
  }
  return new TableClient(`https://${storage.accountName}.table.${storage.suffix}`, name, new DefaultAzureCredential());
}

export function openTables(storage: StorageSource): DataTables {
  return { auth: openTable(storage, authTableName), ledger: openTable(storage, ledgerTableName) };
}

export function openBackupContainer(storage: StorageSource, container: string): ContainerClient {
  const service = storage.kind === "connectionString"
    ? BlobServiceClient.fromConnectionString(storage.connection)
    : new BlobServiceClient(`https://${storage.accountName}.blob.${storage.suffix}`, new DefaultAzureCredential());
  return service.getContainerClient(container);
}
