# Among Us Kiwis
a kiwi themed among us clone multiplayer web/mobile video game for victoria uni openday

## Getting started 

### docker ecs machines (cloudflared tunnel)
run docker container on ecs server user with cloudflared quick tunnel 
```
podman compose -f container/docker-compose.yml up --build
```
then access the cloudflared url on any device and enjoy.

### ssh dev test on ecs machines (ssh port forwarding)
unning server on an ecs server user and then player machine sshs into that machine and port forwards

ssh into ecs machine and start the server (through entry jump proxy)
```bash
ssh -J xxxxxxxxxx@entry.ecs.vuw.ac.nz xxxxxxxxxx@embassy.ecs.vuw.ac.nz
```
now port forward to local
```bash
 ssh -L 10000:localhost:10000 -J xxxxxxxxxx@entry.ecs.vuw.ac.nz xxxxxxxxxx@embassy.ecs.vuw.ac.nz
```