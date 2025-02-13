import { useCallback, useEffect } from 'react';
import { useRecoilState } from 'recoil';

import Logger from 'app/features/global/framework/logger-service';
import { useRealtimeRoom } from 'app/features/global/hooks/use-realtime';
import { OnlineUsersState, OnlineUserType } from '../state/atoms/online-users';
import useWebSocket from '../../global/hooks/use-websocket';
import {
  OnlineUserRealtimeAPI,
  ONLINE_ROOM,
  RealtimeUpdateMessageType,
} from '../../../features/users/api/online-user-realtime-api-client';
import JWTStorage from '../../auth/jwt-storage-service';
import useRouterCompany from 'app/features/router/hooks/use-router-company';

const logger = Logger.getLogger('useOnlineUsers');

const GET_INTERVAL = 10000;
const SET_INTERVAL = 600000;
let getIntervalId: any;
let setIntervalId: any;

export const useOnlineUsers = (): void => {
  logger.trace('Running online hook');
  const { websocket } = useWebSocket();
  const companyId = useRouterCompany();
  const [onlineUsers, setOnlineUsersState] = useRecoilState(OnlineUsersState);

  const updateOnline = useCallback((statuses: Array<[string, boolean]> = []): void => {
    logger.debug(`Update online status for ${statuses.length} users`);
    const lastSeen = Date.now();
    setOnlineUsersState(users => {
      if (!statuses.length) {
        return users;
      }

      const previousStateMap = new Map<string, OnlineUserType>(users.map(u => [u.id!, u]));

      for (const statusTuple of statuses) {
        previousStateMap.set(statusTuple[0], {
          id: statusTuple[0],
          connected: statusTuple[1],
          lastSeen,
          initialized: true,
        });
      }

      return [...previousStateMap.entries()].map(entry => ({
        id: entry[0],
        connected: entry[1].connected,
        lastSeen: entry[1].lastSeen,
        initialized: true,
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (websocket) {
      // got some local users, ask if there are still online
      const api = OnlineUserRealtimeAPI(websocket, companyId);
      getIntervalId = setInterval(async () => {
        const users = onlineUsers.map(u => u.id).filter(<T>(n?: T): n is T => Boolean(n));
        const status = await api.getUsersStatus(users);
        updateOnline(status);
      }, GET_INTERVAL);

      setIntervalId = setInterval(async () => await api.setMyStatus(), SET_INTERVAL);
    }

    return () => {
      getIntervalId && clearInterval(getIntervalId);
      setIntervalId && clearInterval(setIntervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [websocket, onlineUsers]);

  // listen to room events in which online events are pushed
  useRealtimeRoom<RealtimeUpdateMessageType>(
    { room: ONLINE_ROOM(companyId), token: JWTStorage.getJWT() },
    'useOnlineUsers',
    (action, resource) => {
      if (action === 'event' && resource?.length) {
        logger.trace('Updating online users');
        updateOnline(resource);
      } else {
        logger.warn('Received unsupported event', action);
      }
    },
  );
};
