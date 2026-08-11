/** eval/ 独立 jest 配置：主配置 rootDir=src，扫不到 eval 目录 */
module.exports = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    testRegex: '.*\\.spec\\.ts$',
    transform: {
        '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: require('path').resolve(__dirname, '../tsconfig.json') }],
    },
    testEnvironment: 'node',
    moduleNameMapper: {
        '^@zilliz/milvus2-sdk-node$': '<rootDir>/../src/test-mocks/milvus-sdk.stub.ts',
    },
};
