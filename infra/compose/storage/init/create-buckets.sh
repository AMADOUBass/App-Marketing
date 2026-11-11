#!/bin/sh
# Creates the media bucket (private: access only through signed URLs) and its CORS rules.
# Safe to run again: existing buckets are kept.
set -eu

bucket="$S3_BUCKET_MEDIA"

if aws s3api head-bucket --bucket "$bucket" > /dev/null 2>&1; then
  echo "Bucket '$bucket' already exists"
else
  aws s3api create-bucket --bucket "$bucket" > /dev/null
  echo "Bucket '$bucket' created"
fi

# Browsers upload directly with signed (multipart) URLs; ETag must be exposed to complete multipart.
aws s3api put-bucket-cors --bucket "$bucket" --cors-configuration file:///init/cors.json
echo "CORS rules applied to '$bucket'"
