# URL for the MTGJSON v5 AtomicCards endpoint
$url = "https://mtgjson.com/api/v5/AtomicCards.json"
$outputFile = "AtomicCards.json"

Write-Host "Fetching latest AtomicCards.json from MTGJSON..." -ForegroundColor Cyan

# Use Windows native curl.exe if available for built-in progress bar, otherwise use Invoke-WebRequest
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    curl.exe -L $url -o $outputFile --progress-bar
} else {
    Invoke-WebRequest -Uri $url -OutFile $outputFile
}

Write-Host "Successfully downloaded $outputFile" -ForegroundColor Green