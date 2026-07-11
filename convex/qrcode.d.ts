declare module "qrcode" {
  const QRCode: {
    toBuffer(text: string, options?: unknown): Promise<any>;
  };

  export default QRCode;
}
