import WebSocketService from '../../global/services/websocket-service';
import Logger from '../../global/framework/logger-service';
import { RealtimeEventAction } from '../../global/types/realtime-types';
import UsersService from 'app/features/users/services/current-user-service';
const logger = Logger.getLogger('OnlineUsersRealtimeAPI');

export type GetUserRequestType = string;
export type GetUsersRequestType = Array<GetUserRequestType>;
export type GetUserResponseType = [string, boolean];
export type GetUsersResponseType = Array<GetUserResponseType>;
export type RealtimeUpdateMessageType = GetUsersResponseType;
export type SubscribeReturn = {
  name: string;
  unsubscribe: () => void;
};

export type OnlineUserRealtimeAPIType = {
  getUserStatus: (id: GetUserRequestType) => Promise<GetUserResponseType>;
  getUsersStatus: (ids: GetUsersRequestType) => Promise<GetUsersResponseType>;
  setMyStatus: () => void;
  subscribe: (onUpdate: (users: RealtimeUpdateMessageType) => void) => SubscribeReturn;
};

export const ONLINE_ROOM = (companyId: string) => `/users/online/${companyId}`;

export const OnlineUserRealtimeAPI = (websocket: WebSocketService, companyId: string): OnlineUserRealtimeAPIType => {
  const getUserStatus = (id: GetUserRequestType): Promise<GetUserResponseType> => {
    logger.debug(`Get user online status ${id}`);
    return getUsersStatus([id]).then(response => response?.[0] || [id, false]);
  };

  const getUsersStatus = (ids: GetUsersRequestType = []): Promise<GetUsersResponseType> => {
    logger.debug(`Get users statuses ${ids.join(',')}`);
    return websocket
      .get<GetUsersRequestType, GetUsersResponseType>('online:get', ids)
      .then(result => result || []);
  };

  const setMyStatus = (): void => {
    const id = UsersService.getCurrentUserId();
    logger.debug(`Set user online status ${id}`);

    websocket
      .get<GetUsersRequestType, GetUsersResponseType>('online:set', [id])
      .then(result => result || []);
  };

  const subscribe = (onUpdate: (users: RealtimeUpdateMessageType) => void): SubscribeReturn => {
    const name = `${ONLINE_ROOM(companyId)}/@OnlineUsersRealtimeAPI`;

    websocket.join(
      ONLINE_ROOM(companyId),
      '',
      name,
      (
        type: string,
        event: { action: RealtimeEventAction; resource: RealtimeUpdateMessageType },
      ) => {
        if (type === 'realtime:resource') {
          if (event.action === 'event') {
            onUpdate(event.resource || []);
          }
        } else if (type === 'realtime:join:success') {
          logger.debug(`Room ${ONLINE_ROOM(companyId)} has been joined`);
        } else {
          logger.debug('Event type is not supported', type);
        }
      },
    );

    return {
      name,
      unsubscribe: () => websocket.leave(ONLINE_ROOM(companyId), name),
    };
  };

  return {
    getUserStatus,
    getUsersStatus,
    subscribe,
    setMyStatus,
  };
};
