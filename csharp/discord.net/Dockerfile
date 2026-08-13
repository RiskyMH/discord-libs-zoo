FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY Honeypot.csproj .
RUN dotnet restore
COPY Program.cs .
RUN dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/runtime:8.0
WORKDIR /app
COPY --from=build /app/publish .
RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]
CMD ["dotnet", "Honeypot.dll"]
