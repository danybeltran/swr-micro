### swr-micro

(WIP) A lightweight SWR implementation using `atomic-state`


Example code
```tsx
import useSWR from 'swr-micro'

export default function Page() {
  const [page, setPage] = useState(1)

  const { data, loading, error } = useSWR('https://jsonplaceholder.typicode.com/todos/[id]', {
    params: {
      id: page
    }
  })

  if(loading) return <p>Loading</p>

  if(error) return <p>Error</p>

  return (
    <main>
      <div
        style={{
          display: 'flex',
          justifyContent: 'center'
        }}>
        <button onClick={() => setPage(page - 1)}>{'<'}</button>
        <div style={{ width: '60px', textAlign: 'center' }}>{page}</div>
        <button onClick={() => setPage(page + 1)}>{'>'}</button>
      </div>
      <br />
      <button onClick={todo.revalidate}>Refresh</button>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </main>
  )
}
```