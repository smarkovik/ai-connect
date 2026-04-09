/** Type declarations for the @callifly/common shared package. */
declare module "@callifly/common" {
  export function reportToSlack(
    channel: { name: string; url: string },
    message: string
  ): Promise<void>;
}
