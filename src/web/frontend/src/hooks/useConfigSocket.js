import { useEffect, useRef, useState } from "react";

export default function useConfigSocket({
  enabled,
  token,
  onMessage,
  onUnauthorized,
}) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const handlersRef = useRef({ onMessage, onUnauthorized });

  useEffect(() => {
    handlersRef.current = { onMessage, onUnauthorized };
  }, [onMessage, onUnauthorized]);

  useEffect(() => {
    window.clearTimeout(retryRef.current);
    if (!enabled) {
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
      return undefined;
    }

    let active = true;

    const connect = () => {
      if (!active) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(`${protocol}//${window.location.host}/ws`);
      if (token) url.searchParams.set("token", token);

      try {
        const socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!active) {
            socket.close();
            return;
          }
          setConnected(true);
        };

        socket.onmessage = (event) => {
          try {
            handlersRef.current.onMessage?.(JSON.parse(event.data));
          } catch {
            // 服务端消息格式异常时忽略，连接仍可继续使用。
          }
        };

        socket.onclose = (event) => {
          if (socketRef.current === socket) socketRef.current = null;
          setConnected(false);
          if (!active) return;
          if (event.code === 1008) {
            active = false;
            handlersRef.current.onUnauthorized?.();
            return;
          }
          retryRef.current = window.setTimeout(connect, 3000);
        };

        socket.onerror = () => socket.close();
      } catch {
        retryRef.current = window.setTimeout(connect, 3000);
      }
    };

    connect();
    return () => {
      active = false;
      window.clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, token]);

  return connected;
}
