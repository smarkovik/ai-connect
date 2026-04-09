import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  moduleNameMapper: {
    // Mock the @callifly/common local package so tests don't need it installed
    "^@callifly/common$": "<rootDir>/__mocks__/@callifly/common.ts",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          types: ["node", "jest"],
          rootDir: ".",
        },
      },
    ],
  },
  testPathIgnorePatterns: ["/node_modules/", "fixtures\\.ts$"],
};

export default config;
