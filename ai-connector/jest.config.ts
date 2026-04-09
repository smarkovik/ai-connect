import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
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
