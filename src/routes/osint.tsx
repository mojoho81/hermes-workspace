import { createFileRoute } from '@tanstack/react-router'
import { OsintScreen } from '@/screens/osint/osint-screen'

export const Route = createFileRoute('/osint')({
  ssr: false,
  component: OsintScreen,
})
