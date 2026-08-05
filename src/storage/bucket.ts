import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.REGION || "auto",
  endpoint: process.env.ENDPOINT,
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID || "",
    secretAccessKey: process.env.SECRET_ACCESS_KEY || "",
  },
  forcePathStyle: process.env.AWS_S3_URL_STYLE === "path",
});

function bucketName(): string {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error("BUCKET environment variable is not set");
  return bucket;
}

export async function putFile(key: string, body: Buffer, contentType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucketName(), Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}
