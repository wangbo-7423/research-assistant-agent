// Jest 测试桩：替代 @zilliz/milvus2-sdk-node，避免其 ESM 依赖（thrift/uuid）导致 Jest 解析失败
export class MilvusClient {
  constructor(_opts?: any) {}
  hasCollection = jest.fn();
  createCollection = jest.fn();
  createIndex = jest.fn();
  loadCollection = jest.fn();
  describeCollection = jest.fn();
  dropCollection = jest.fn();
  insert = jest.fn();
  flush = jest.fn();
  search = jest.fn();
  query = jest.fn();
  delete = jest.fn();
}

export const DataType = {
  Int64: 5,
  VarChar: 21,
  FloatVector: 101,
};
