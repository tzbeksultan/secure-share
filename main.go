package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"
)

type App struct { db *sql.DB; origin string }
type createRequest struct { Secret string `json:"secret"`; Ciphertext string `json:"ciphertext"`; Pin string `json:"pin"`; ExpiresIn int `json:"expiresIn"` }
type consumeRequest struct { Secret string `json:"secret"`; Pin string `json:"pin"` }
type shareResponse struct { Ciphertext string `json:"ciphertext"`; ExpiresAt time.Time `json:"expiresAt"` }
type errorResponse struct { Error string `json:"error"` }

func hash(s string) string { h:=sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func writeJSON(w http.ResponseWriter, status int, v any) { w.Header().Set("Content-Type","application/json"); w.WriteHeader(status); _=json.NewEncoder(w).Encode(v) }
func (a *App) cors(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
	origin:=r.Header.Get("Origin")
	if origin!="" && (a.origin=="*" || origin==a.origin) { w.Header().Set("Access-Control-Allow-Origin",origin); w.Header().Set("Vary","Origin") }
	w.Header().Set("Access-Control-Allow-Headers","Content-Type, X-Share-Secret")
	w.Header().Set("Access-Control-Allow-Methods","GET, POST, OPTIONS")
	if r.Method=="OPTIONS" { w.WriteHeader(http.StatusNoContent); return }; next.ServeHTTP(w,r)
}) }
func (a *App) health(w http.ResponseWriter,r *http.Request) { if r.Method!="GET" { w.WriteHeader(405); return }; if err:=a.db.PingContext(r.Context()); err!=nil { writeJSON(w,503,errorResponse{"database unavailable"}); return }; writeJSON(w,200,map[string]string{"status":"ok"}) }
func (a *App) create(w http.ResponseWriter,r *http.Request) {
	if r.Method!="POST" { w.WriteHeader(405); return }
	r.Body=http.MaxBytesReader(w,r.Body,14<<20)
	var in createRequest
	if json.NewDecoder(r.Body).Decode(&in)!=nil || len(in.Secret)<32 || len(in.Ciphertext)==0 || len(in.Ciphertext)>12<<20 { writeJSON(w,400,errorResponse{"invalid request"}); return }
	ttl:=in.ExpiresIn; if ttl<1 || ttl>10080 { ttl=1440 }
	var pinHash string
	if in.Pin!="" { if len(in.Pin)<4 || len(in.Pin)>64 { writeJSON(w,400,errorResponse{"PIN must be 4–64 characters"}); return }; b,err:=bcrypt.GenerateFromPassword([]byte(in.Pin),bcrypt.DefaultCost); if err!=nil { writeJSON(w,500,errorResponse{"could not secure PIN"}); return }; pinHash=string(b) }
	expires:=time.Now().UTC().Add(time.Duration(ttl)*time.Minute)
	var id string
	err:=a.db.QueryRowContext(r.Context(),`INSERT INTO shares(secret_hash,ciphertext,pin_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING id`,hash(in.Secret),in.Ciphertext,nullIfEmpty(pinHash),expires).Scan(&id)
	if err!=nil { log.Printf("create share: %v",err); writeJSON(w,500,errorResponse{"could not create share"}); return }
	writeJSON(w,201,map[string]any{"id":id,"expiresAt":expires})
}
func nullIfEmpty(s string) any { if s=="" { return nil }; return s }
func (a *App) consume(w http.ResponseWriter,r *http.Request) {
	if r.Method!="POST" { w.WriteHeader(405); return }
	id:=strings.TrimPrefix(r.URL.Path,"/api/shares/")
	if id=="" || strings.Contains(id,"/") { writeJSON(w,404,errorResponse{"share not found"}); return }
	r.Body=http.MaxBytesReader(w,r.Body,2048)
	var in consumeRequest
	if json.NewDecoder(r.Body).Decode(&in)!=nil || len(in.Secret)<32 { writeJSON(w,400,errorResponse{"invalid request"}); return }
	tx,err:=a.db.BeginTx(r.Context(),nil); if err!=nil { writeJSON(w,500,errorResponse{"server error"}); return }; defer tx.Rollback()
	var ciphertext string; var pinHash sql.NullString; var expires time.Time; var secretHash string; var consumed bool
	err=tx.QueryRowContext(r.Context(),`SELECT secret_hash,ciphertext,pin_hash,expires_at,consumed FROM shares WHERE id=$1 FOR UPDATE`,id).Scan(&secretHash,&ciphertext,&pinHash,&expires,&consumed)
	if errors.Is(err,sql.ErrNoRows) || err!=nil { writeJSON(w,404,errorResponse{"share not found or unavailable"}); return }
	if consumed || time.Now().After(expires) || hash(in.Secret)!=secretHash { writeJSON(w,404,errorResponse{"share not found or unavailable"}); return }
	if pinHash.Valid && bcrypt.CompareHashAndPassword([]byte(pinHash.String),[]byte(in.Pin))!=nil { writeJSON(w,403,errorResponse{"incorrect PIN"}); return }
	if _,err=tx.ExecContext(r.Context(),`UPDATE shares SET consumed=TRUE WHERE id=$1`,id); err!=nil { writeJSON(w,500,errorResponse{"server error"}); return }
	if err=tx.Commit(); err!=nil { writeJSON(w,500,errorResponse{"server error"}); return }
	writeJSON(w,200,shareResponse{ciphertext,expires})
}
func main() {
	dsn:=os.Getenv("DATABASE_URL"); if dsn=="" { log.Fatal("DATABASE_URL is required") }
	db,err:=sql.Open("pgx",dsn); if err!=nil { log.Fatal(err) }; defer db.Close()
	db.SetMaxOpenConns(10); db.SetMaxIdleConns(3); db.SetConnMaxLifetime(30*time.Minute)
	ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second); defer cancel()
	if err=db.PingContext(ctx); err!=nil { log.Fatal(err) }
	_,err=db.ExecContext(ctx,`CREATE TABLE IF NOT EXISTS shares (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		secret_hash CHAR(64) NOT NULL,
		ciphertext TEXT NOT NULL,
		pin_hash TEXT NULL,
		expires_at TIMESTAMPTZ NOT NULL,
		consumed BOOLEAN NOT NULL DEFAULT FALSE,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	CREATE INDEX IF NOT EXISTS shares_expires_idx ON shares(expires_at);`)
	if err!=nil { log.Fatal(err) }
	app:=&App{db:db,origin:strings.TrimRight(os.Getenv("FRONTEND_ORIGIN"),"/")}
	mux:=http.NewServeMux(); mux.HandleFunc("/healthz",app.health); mux.HandleFunc("/api/shares",app.create); mux.HandleFunc("/api/shares/",app.consume)
	port:=os.Getenv("PORT"); if port=="" { port="8080" }
	srv:=&http.Server{Addr:":"+port,Handler:app.cors(mux),ReadHeaderTimeout:5*time.Second,ReadTimeout:20*time.Second,WriteTimeout:30*time.Second,IdleTimeout:60*time.Second}
	log.Printf("secure-share API listening on :%s",port)
	log.Fatal(srv.ListenAndServe())
}
