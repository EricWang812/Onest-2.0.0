/**
 * Minimal ambient typings for the `spake2` npm package (v1.0.2), which ships
 * no .d.ts of its own. Covers only the symmetric (non-plus) SPAKE2 surface
 * this project uses. See DECISIONS.md for the caveats on this library.
 */
declare module 'spake2' {
  export class ClientSPAKE2State {
    getMessage(): Buffer;
    finish(incoming: Buffer): ClientSharedSecret;
  }
  export class ServerSPAKE2State {
    getMessage(): Buffer;
    finish(incoming: Buffer): ServerSharedSecret;
  }
  export class ClientSharedSecret {
    toBuffer(): Buffer;
    getConfirmation(): Buffer;
    verify(incoming: Buffer): void;
  }
  export class ServerSharedSecret {
    toBuffer(): Buffer;
    getConfirmation(): Buffer;
    verify(incoming: Buffer): void;
  }
  export interface Spake2Options {
    suite?: string;
    mhf: { n: number; r: number; p: number };
    kdf: { AAD: string };
  }
  export interface Spake2Instance {
    startClient(
      clientIdentity: string,
      serverIdentity: string,
      password: string,
      salt: Buffer,
    ): Promise<ClientSPAKE2State>;
    startServer(
      clientIdentity: string,
      serverIdentity: string,
      verifier: Buffer,
    ): Promise<ServerSPAKE2State>;
    computeVerifier(password: string, salt: Buffer): Promise<Buffer>;
  }
  export function spake2(options: Spake2Options): Spake2Instance;
}
