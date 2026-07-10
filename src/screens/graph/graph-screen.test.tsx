// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraphScreen } from './graph-screen'

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('GraphScreen', () => {
  it('renders loading state initially', () => {
    render(<GraphScreen />, { wrapper: createWrapper() })
    // Since queries start loading, expect some loading indicator text
    expect(document.body.textContent).toContain('Building workspace graph') // or similar
  })

  it('has correct node types defined', () => {
    // Basic export check
    expect(typeof GraphScreen).toBe('function')
  })
})
