import Link from 'next/link'
 
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#0F0F1A] text-[#F1F5F9]">
      <h2 className="text-4xl font-bold mb-4">Not Found</h2>
      <p className="text-[#94A3B8] mb-8">Could not find requested resource</p>
      <Link href="/" className="px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white rounded-md transition-colors">
        Return Home
      </Link>
    </div>
  )
}
