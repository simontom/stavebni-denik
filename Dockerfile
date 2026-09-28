FROM gradle:8.10-jdk21-alpine AS builder
WORKDIR /app
COPY . .
RUN cd backend && gradle build -x test --no-daemon

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/backend/build/libs/*-all.jar ./app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
