import { Atom, atom, useAtom } from 'atomic-state'
import { useEffect, useLayoutEffect } from 'react'

// type
type RequestStatus<DataType = any> = {
  data: DataType
  loading: boolean
  error: boolean
  revalidating: boolean
  start: Date
  end: Date
  status: number
  success: boolean
  responseTime: number
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

// constants
const requests = new Map<string, RequestAtom<any>>()
const previousConfigs = new Map<string, any>()

const initialized = new Map<string, boolean>()
const withSuspense = new Map<string, Response>()

const abortControllers = new Map<string, AbortController>()

// per-config cache
const cached = new Map<string, any>()

// For response times
const started = new Map<string, number>()

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

/**
 *
 * @param str The target string
 * @param $params The params to parse in the url
 *
 * Params should be separated by `"/"`, (e.g. `"/api/[resource]/:id"`)
 *
 * URL search params will not be affected
 */
export function setURLParams(str: string = '', $params: any = {}) {
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

function setUpSWR(url, config: any = {}) {
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
                  started.set(keyStr, Date.now())
                }
                try {
                  abortControllers.get(keyStr)?.abort()
                  const abortController = new AbortController()
                  abortControllers.set(keyStr, abortController)
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
                      params: undefined,
                      signal: abortController.signal
                    }
                  )

                  const d = res.data ?? (await res.json())

                  cached.set(JSON.stringify($config), d)

                  if (res.status >= 400) {
                    newState = dispatchTypes.flagError({
                      data: d,
                      end: new Date(),
                      responseTime: Date.now() - (started.get(keyStr) || 0),
                      status: res.status,
                      success: false
                    })
                  } else {
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
  url,
  config: RequestInit & {
    key?: any
    query?: any
    params?: any
    default?: T
    suspense?: boolean
    auto?: boolean
    fetcher?: (url: string, cfg: any) => any
  } = {}
) {
  const key = setUpSWR(url, config)

  const [swr, , swrActions] = useAtom<RequestStatus<T>, RequestActions<T>>(
    requests.get(key) as any
  )

  if (config?.suspense && swr.loading && !initialized.get(key)) {
    throw swrActions.initializeRevalidation({ $config: config })
  } else {
    swrActions.initializeRevalidation({ $config: config })
  }

  useIsomorphicLayoutEffect(() => {
    if (config?.auto ?? true)
      swrActions.initializeRevalidation({ revalidation: true, $config: config })
  }, [JSON.stringify(config)])

  return {
    ...swr,
    key: JSON.parse(key),
    revalidate: () =>
      swrActions.initializeRevalidation({
        revalidation: true,
        $config: config,
        forced: true
      }),
    mutate: swrActions.mutate
  }
}

export default useSWR
