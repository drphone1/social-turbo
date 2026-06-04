'use client'
 
import { useEffect } from 'react'
 
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])
 
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#0F0F1A] text-[#F1F5F9]">
      <h2 className="text-4xl font-bold mb-4">Something went wrong!</h2>
      <button
        onClick={() => reset()}
        className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white rounded-md transition-colors"
      >
        Try again
      </button>
    </div>
  )
}
