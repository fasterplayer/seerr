import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { NotFoundInfo } from '@server/lib/notfound';
import { Notification } from '@server/lib/notifications';
import path from 'path';
import { In } from 'typeorm';

export const NOTIFIED_FILE = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/introuvable-notifies.json`
  : path.join(__dirname, '../../config/introuvable-notifies.json');

// '2026-10-28 23:47 UTC': the server has no user locale
const searchedDate = (iso: string): string =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const notFoundReason = (
  info: NotFoundInfo,
  mediaType: MediaType
): string => {
  if (info.reason === 'searched') {
    return `Searched on ${searchedDate(info.checkedAt)} by ${
      mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr'
    }, nothing found`;
  }
  return info.reason === 'noResults'
    ? 'No results from the indexers'
    : `${info.count} result${info.count === 1 ? '' : 's'} rejected${
        info.rejection ? `: ${info.rejection}` : ''
      }`;
};

/**
 * One MEDIA_NOT_FOUND notification per active (approved) request of the item.
 * Returns how many were sent.
 */
export const notifyNotFound = async (
  mediaType: MediaType,
  serverIds: number[],
  externalId: number,
  info: NotFoundInfo
): Promise<number> => {
  const requests = await getRepository(MediaRequest).find({
    where: [
      {
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        media: {
          mediaType,
          serviceId: In(serverIds),
          externalServiceId: externalId,
        },
      },
      {
        status: MediaRequestStatus.APPROVED,
        is4k: true,
        media: {
          mediaType,
          serviceId4k: In(serverIds),
          externalServiceId4k: externalId,
        },
      },
    ],
  });

  for (const request of requests) {
    await MediaRequest.sendNotification(
      request,
      request.media,
      Notification.MEDIA_NOT_FOUND,
      notFoundReason(info, mediaType)
    );
  }

  return requests.length;
};
