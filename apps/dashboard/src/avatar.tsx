// A person as a small round picture: theirs, when they gave one, or the first letters of what
// they are called. The picture is asked for by which one it is, so a new one is a new address.

import { ApiError } from '@acentric/client';
import type { User } from '@acentric/protocol';

/** The first two letters or digits of what a person is called. */
export function initialsOf(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase();
}

export function photoUrl(user: string, photo: string): string {
  return `/v1/users/${user}/photo?v=${encodeURIComponent(photo)}`;
}

export function Avatar({
  user,
  photo,
  name,
  size = 28,
  className = 'me__avatar',
}: {
  user: string;
  photo: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size };
  if (photo === null || photo === undefined) {
    return (
      <span className={className} style={style} aria-hidden="true">
        {initialsOf(name)}
      </span>
    );
  }
  return (
    <img
      className={`${className} avatar-photo`}
      style={style}
      src={photoUrl(user, photo)}
      alt=""
      width={size}
      height={size}
    />
  );
}

/** The most a picture chosen may be, before it is made small to send. */
export const CHOSEN_BYTES = 10 * 1024 * 1024;
/** How many pixels a side the picture sent is. */
const SIDE = 512;

/**
 * A picture chosen, made what is sent: its middle square, 512 pixels a side, as WebP (or PNG
 * where the browser makes no WebP). Nothing of it is shown before it is sent.
 */
export async function squarePhoto(file: Blob): Promise<Blob> {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(SIDE, side);
  canvas.height = canvas.width;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser cannot make the picture smaller');
  context.drawImage(
    image,
    (image.width - side) / 2,
    (image.height - side) / 2,
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  image.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('The picture could not be made'));
        else resolve(blob);
      },
      'image/webp',
      0.9,
    );
  });
}

/** Sends the picture of the person signed in: they as they then are. */
export async function sendPhoto(photo: Blob): Promise<User> {
  const response = await fetch('/v1/me/photo', {
    method: 'PUT',
    headers: { 'content-type': photo.type || 'application/octet-stream' },
    body: photo,
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (body.error ?? {}) as ConstructorParameters<typeof ApiError>[1],
    );
  }
  return body as User;
}
