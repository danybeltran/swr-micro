import { Atom, atom, useAtom } from 'atomic-state'
import { useEffect, useLayoutEffect } from 'react'

// types
type RequestStatus<DataType = any> = {
  data: DataType
  loading: boolean
  error: boolean
  revalidating: boolean
  start: Date
  end: Date | null
  status: number | null
  success: boolean
  responseTime: number | null
  key: any
}
type RequestActions<R> = {
  initializeRevalidation: {
    revalidation?: boolean
    $config: any
    forced?: boolean
    refreshing?: boolean
  }
  mutate: R
}
type RequestAtom<T> = Atom<RequestStatus<T>, RequestActions<T>>

type TimeSpan =
  | number
  | `${string} ${'ms' | 'sec' | 'min' | 'h' | 'd' | 'we' | 'mo' | 'y'}`

// constants
const requests = new Map<string, RequestAtom<any>>()
const previousConfigs = new Map<string, any>()

const initialized = new Map<string, boolean>()
const withSuspense = new Map<string, Response>()

// For running requests
const runningRequests = new Map<string, boolean>()

const abortControllers = new Map<string, AbortController>()

// per-config cache
const cached = new Map<string, any>()

// For response times
const started = new Map<string, number>()

// For error retry
const completedAttempts = new Map<string, number>()

const dispatchTypes = {
  firstLoad: other => prev => ({
    ...prev,
    ...other,
    loading: true,
    error: false,
    revalidating: false
  }),
  success: other => prev => ({
    ...prev,
    ...other,
    loading: false,
    error: false,
    revalidating: false
  }),
  revalidate: other => prev => ({
    ...prev,
    ...other,
    loading: true,
    error: false,
    revalidating: true
  }),
  flagError: other => prev => ({
    ...prev,
    ...other,
    loading: false,
    error: true,
    revalidating: false
  })
}

function serialize(input) {
  return JSON.stringify(input)
}

function getMiliseconds(v: TimeSpan): number {
  const UNITS_MILISECONDS_EQUIVALENTS = {
    ms: 1,
    sec: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
    we: 604800000,
    mo: 2629800000,
    y: 31536000000
  }

  if (typeof v === 'number') return v

  const [amount, unit] = (v as string).split(' ')

  const amountNumber = parseFloat(amount)

  if (!(unit in UNITS_MILISECONDS_EQUIVALENTS)) {
    return amountNumber
  }
  // @ts-ignore - This should return the value in miliseconds
  return amountNumber * UNITS_MILISECONDS_EQUIVALENTS[unit]
}

/**
 *
 * @param str The target string
 * @param $params The params to parse in the url
 *
 * Params should be separated by `"/"`, (e.g. `"/api/[resource]/:id"`)
 *
 * URL search params will not be affected
 */
function setURLParams(str: string = '', $params: any = {}) {
  const hasQuery = str.includes('?')

  const queryString =
    '?' +
    str
      .split('?')
      .filter((_, i) => i > 0)
      .join('?')

  return (
    str
      .split('/')
      .map($segment => {
        const [segment] = $segment.split('?')
        if (segment.startsWith('[') && segment.endsWith(']')) {
          const paramName = segment.replace(/\[|\]/g, '')
          if (!(paramName in $params)) {
            console.warn(
              `Param '${paramName}' does not exist in params configuration for '${str}'`
            )
            return paramName
          }

          return $params[segment.replace(/\[|\]/g, '')]
        } else if (segment.startsWith(':')) {
          const paramName = segment.split('').slice(1).join('')
          if (!(paramName in $params)) {
            console.warn(
              `Param '${paramName}' does not exist in params configuration for '${str}'`
            )
            return paramName
          }
          return $params[paramName]
        } else {
          return segment
        }
      })
      .join('/') + (hasQuery ? queryString : '')
  )
}

function setupSWR(url: string, config: any = {}) {
  const key = config?.key || [config?.method || 'GET', url].join(' ')

  const keyStr = JSON.stringify(key)
  if (previousConfigs.get(keyStr) !== JSON.stringify(config)) {
    if (true) {
      const { query = {} } = config || {}
      const thisQuery = Object.keys(query)
        .map(q => [q, query[q]].join('='))
        .join('&')

      requests.set(
        keyStr,
        atom({
          name: keyStr,
          default: {
            data: config.default,
            start: new Date(),
            currentRequest: undefined,
            loading: config?.auto ?? true,
            error: false,
            end: null,
            status: null,
            success: false,
            responseTime: null,
            key: undefined,
            revalidating: false
          },
          actions: {
            async initializeRevalidation({ args, state, dispatch }) {
              const $config = args?.$config
              const fetcher = $config?.fetcher || fetch
              const startRevalidation = $config?.auto ?? true
              let newState
              if (
                args?.revalidation
                  ? args?.forced
                    ? true
                    : previousConfigs.get(keyStr) !== JSON.stringify($config)
                  : !initialized.get(keyStr) && startRevalidation
              ) {
                if (previousConfigs.get(keyStr) !== JSON.stringify($config)) {
                  completedAttempts.set(keyStr, 0)
                }
                previousConfigs.set(keyStr, JSON.stringify($config))
                initialized.set(keyStr, true)
                if (!state.loading) {
                  dispatch(prev => ({
                    ...prev,
                    ...dispatchTypes.firstLoad({
                      data: cached.get(JSON.stringify($config)) ?? prev.data,
                      start: new Date()
                    })(prev)
                  }))
                  runningRequests.set(keyStr, true)
                  started.set(keyStr, Date.now())
                }
                try {
                  abortControllers.get(keyStr)?.abort()
                  const abortController = new AbortController()
                  abortControllers.set(keyStr, abortController)

                  const newHeaders = {
                    'Content-type': 'application/json',
                    ...$config?.headers
                  }
                  const res = await fetcher(
                    setURLParams(
                      url +
                        (url.includes('?')
                          ? url.endsWith('?')
                            ? ''
                            : '&'
                          : '?') +
                        thisQuery,
                      $config?.params || {}
                    ),
                    {
                      ...$config,
                      headers: newHeaders,
                      body:
                        newHeaders['Content-type'] !== 'application/json'
                          ? $config?.body
                          : serialize($config?.body),
                      params: undefined,
                      signal: abortController.signal
                    }
                  )

                  const d = res.data ?? (await res.json())

                  cached.set(JSON.stringify($config), d)

                  if (res.status >= 400) {
                    const previousAttempts = completedAttempts.get(keyStr) || 0
                    completedAttempts.set(keyStr, previousAttempts + 1)
                    newState = dispatchTypes.flagError({
                      data: d,
                      end: new Date(),
                      responseTime: Date.now() - (started.get(keyStr) || 0),
                      status: res.status,
                      success: false
                    })
                  } else {
                    completedAttempts.set(keyStr, 0)
                    newState = dispatchTypes.success({
                      data: d,
                      end: new Date(),
                      responseTime: Date.now() - (started.get(keyStr) || 0),
                      status: res.status,
                      success: true
                    })
                  }
                } catch (err) {
                  if (!/abort/.test(err.toString())) {
                    const previousAttempts = completedAttempts.get(keyStr) || 0
                    completedAttempts.set(keyStr, previousAttempts + 1)
                    newState = prev =>
                      dispatchTypes.flagError({
                        data: prev.data,
                        end: new Date(),
                        status: err?.response?.status,
                        responseTime: Date.now() - (started.get(keyStr) || 0),
                        success: false
                      })
                  }
                } finally {
                  dispatch(newState)
                  runningRequests.delete(keyStr)
                  withSuspense.delete(keyStr)
                }
              }
              return state
            },
            mutate({ args, dispatch }) {
              dispatch(prev => ({
                ...prev,
                data: args
              }))
            }
          }
        })
      )
    }
  }
  return keyStr
}

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

function useSWR<T = any>(
  url: string,
  config: Omit<RequestInit, 'body'> & {
    body?: any
    key?: any
    query?: any
    params?: any
    default?: T
    suspense?: boolean
    auto?: boolean
    revalidateInterval?: TimeSpan
    fetcher?: (url: string, cfg: any) => any
    revalidateOnFocus?: boolean
    revalidateOnReconnect?: boolean
    onStart?: (req: any) => void
    onEnd?: (res: any) => void
    attempts?: number
    attemptInterval?: TimeSpan
  } = {}
) {
  const { auto = true } = config

  const key = url ? setupSWR(url, config) : serialize(config.key)

  const [swr, , swrActions] = useAtom<RequestStatus<T>, RequestActions<T>>(
    requests.get(key) as any
  )

  if (url && auto && config?.suspense && swr.loading && !initialized.get(key)) {
    throw swrActions.initializeRevalidation({ $config: config })
  } else {
    if (auto && url) {
      swrActions.initializeRevalidation({ $config: config })
    }
  }

  useIsomorphicLayoutEffect(() => {
    if (url) {
      if (auto)
        swrActions.initializeRevalidation({
          revalidation: true,
          $config: config
        })
    }
  }, [serialize({ config, auto, url })])

  useIsomorphicLayoutEffect(() => {
    if (auto && url) {
      if (config?.revalidateInterval) {
        const interval = getMiliseconds(config.revalidateInterval)
        if (interval) {
          const refreshTm = setInterval(() => {
            if (!runningRequests.get(key)) {
              swrActions.initializeRevalidation({
                revalidation: true,
                $config: config,
                forced: true
              })
            }
          }, interval)
          return () => {
            clearInterval(refreshTm)
          }
        }
      }
    }
    return () => {}
  }, [serialize({ config, auto, url, swr })])

  useIsomorphicLayoutEffect(() => {
    if (config.auto && url) {
      if (swr.error && !config?.revalidateInterval) {
        const { attempts = 3, attemptInterval = '2 sec' } = config
        if (attempts > 0) {
          // @ts-ignore
          if (completedAttempts.get(key) < attempts) {
            const errorInterval = getMiliseconds(attemptInterval)
            if (errorInterval) {
              const refreshTm = setTimeout(() => {
                if (!runningRequests.get(key)) {
                  swrActions.initializeRevalidation({
                    revalidation: true,
                    $config: config,
                    forced: true
                  })
                }
              }, errorInterval)
              return () => {
                clearTimeout(refreshTm)
              }
            }
          }
        }
      }
    }
    return () => {}
  }, [serialize({ config, auto, url, swr })])

  useIsomorphicLayoutEffect(() => {
    if (config.auto && url) {
      if (typeof window !== 'undefined') {
        if ('addEventListener' in window) {
          const focusListener = () => {
            if (!runningRequests.get(key)) {
              swrActions.initializeRevalidation({
                revalidation: true,
                $config: config,
                forced: true
              })
            }
          }
          if (config?.revalidateOnFocus) {
            window.addEventListener('focus', focusListener)
          }
          if (config.revalidateOnReconnect) {
            window.addEventListener('online', focusListener)
          }
          return () => {
            window.removeEventListener('focus', focusListener)
            window.removeEventListener('online', focusListener)
          }
        }
      }
    }
    return () => {}
  }, [serialize({ config, auto, url, swr })])

  return {
    ...swr,
    key: JSON.parse(key),
    revalidate: () => {
      completedAttempts.set(key, 0)
      swrActions.initializeRevalidation({
        revalidation: true,
        $config: config,
        forced: true
      })
    },
    cancelRequest: () => {
      completedAttempts.set(key, 0)
      abortControllers.get(key)?.abort()
    },
    mutate: swrActions.mutate
  }
}

export function useSWRKey(key?: any) {
  return useSWR('', { key })
}

export default useSWR
